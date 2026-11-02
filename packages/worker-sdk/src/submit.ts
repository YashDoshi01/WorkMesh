import { z } from "zod";
import { ApiError } from "./client.js";
import { checkApiKey, checkBaseUrl, cleanServerText } from "./security.js";

/**
 * The application side of WorkMesh: queue jobs and look at them afterwards.
 *
 *   const workmesh = new WorkMesh({ apiUrl, apiKey });          // a CLIENT key
 *   await workmesh.jobs.submit({ type: "generate-invoice", payload: { orderId: "ORD-1024" } });
 *
 * (The other half, running jobs, is `Worker`, which uses a WORKER key.)
 */
export interface WorkMeshOptions {
  /** Base URL of WorkMesh, e.g. https://workmesh.example.com */
  apiUrl: string;
  /** A `client` API key (create one under "API keys" in the app). */
  apiKey: string;
  /** Allow a plain-http apiUrl to a remote host. Off by default: the key would travel unencrypted. */
  allowInsecureHttp?: boolean;
  /** Give up on one request after this long. Default 10 s. */
  timeoutMs?: number;
  /**
   * Extra attempts after a failure that is safe to repeat. Default 3. Reads are always repeatable;
   * `jobs.submit` is repeated ONLY when you pass an `idempotencyKey` (see below).
   */
  maxRetries?: number;
  /** Override for tests (fault injection). Defaults to the global fetch. */
  fetch?: typeof fetch;
}

export interface SubmitJobInput {
  /** What kind of job this is. Your worker registers a handler under the same name. */
  type: string;
  /** The data this one run needs, e.g. `{ orderId }`. Keep it small: prefer ids over whole records. */
  payload?: Record<string, unknown>;
  /** 0-100, higher runs first. Default 0. */
  priority?: number;
  /** How many times to try before giving up (1-20). Default 3. */
  maxAttempts?: number;
  /** Do not start before this time (a Date or an ISO-8601 string with an offset). */
  runAt?: Date | string;
  /**
   * Makes the submission safe to repeat. If a request times out or the connection drops you cannot
   * know whether the job was created. With a key, sending the same job again returns the SAME job
   * instead of creating a second one, and this client retries automatically. Use something that
   * identifies the thing you are doing, such as `invoice-${orderId}`. 1-128 characters:
   * letters, digits, . _ : -
   */
  idempotencyKey?: string;
}

const jobSchema = z.object({
  id: z.string(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  priority: z.number(),
  runAt: z.string(),
  scheduledFor: z.string(),
  attemptCount: z.number(),
  maxAttempts: z.number(),
  lastError: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Job = z.infer<typeof jobSchema>;
/** A job as returned by `submit`, plus whether it already existed (an idempotent repeat). */
export type SubmittedJob = Job & { replayed: boolean };

const TYPE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_PAYLOAD_BYTES = 64 * 1024;

const invalid = (message: string): ApiError => new ApiError(0, "invalid_input", message);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Checks what can be checked without asking the server, so a mistake fails at once and clearly. */
export function validateSubmit(input: SubmitJobInput): void {
  if (!TYPE_PATTERN.test(input.type)) {
    throw invalid(
      `job type "${input.type}" is not valid: use 1-100 characters, lowercase letters, digits, '.', '_' or '-', starting with a letter or digit`,
    );
  }
  const payload = input.payload ?? {};
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw invalid("payload must be an object, like { orderId: 'ORD-1024' }");
  }
  let json: string;
  try {
    json = JSON.stringify(payload);
  } catch {
    throw invalid("payload must be plain JSON (no circular references or BigInt)");
  }
  if (Buffer.byteLength(json) > MAX_PAYLOAD_BYTES) {
    throw invalid(`payload is too large (the limit is ${MAX_PAYLOAD_BYTES} bytes)`);
  }
  if (
    input.priority !== undefined &&
    !(Number.isInteger(input.priority) && input.priority >= 0 && input.priority <= 100)
  ) {
    throw invalid("priority must be a whole number from 0 to 100");
  }
  if (
    input.maxAttempts !== undefined &&
    !(Number.isInteger(input.maxAttempts) && input.maxAttempts >= 1 && input.maxAttempts <= 20)
  ) {
    throw invalid("maxAttempts must be a whole number from 1 to 20");
  }
  if (input.runAt !== undefined && Number.isNaN(new Date(input.runAt).getTime())) {
    throw invalid("runAt is not a valid date");
  }
  if (input.idempotencyKey !== undefined && !KEY_PATTERN.test(input.idempotencyKey)) {
    throw invalid("idempotencyKey must be 1-128 characters: letters, digits, '.', '_', ':' or '-'");
  }
}

/** Failures that say "try again": the server is busy or unreachable, not that the request is wrong. */
const retryable = (status: number): boolean => status === 408 || status === 429 || status >= 500;

class Jobs {
  constructor(
    private readonly options: Required<
      Pick<WorkMeshOptions, "apiUrl" | "apiKey" | "timeoutMs" | "maxRetries">
    >,
    private readonly fetchImpl: typeof fetch,
  ) {}

  /** One HTTP exchange. Throws ApiError for anything but a 2xx. */
  private async once(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; json: unknown; headers: Headers }> {
    let res: Response;
    try {
      res = await this.fetchImpl(new URL(path, this.options.apiUrl), {
        method,
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...extraHeaders,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
        // An API never legitimately redirects; following one could carry the key somewhere else.
        redirect: "error",
      });
    } catch {
      throw new ApiError(
        0,
        "network",
        "Could not reach WorkMesh (the request failed or timed out).",
      );
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const e = (
        json as { error?: { code?: string; message?: string; details?: unknown } } | undefined
      )?.error;
      const err = new ApiError(
        res.status,
        typeof e?.code === "string" ? cleanServerText(e.code, 64) : "unknown",
        typeof e?.message === "string"
          ? cleanServerText(e.message)
          : `WorkMesh answered HTTP ${res.status}`,
      );
      if (Array.isArray(e?.details)) err.details = e.details as ApiError["details"];
      const retryAfter = Number(res.headers.get("retry-after"));
      if (Number.isFinite(retryAfter) && retryAfter >= 0) err.retryAfterSeconds = retryAfter;
      throw err;
    }
    return { status: res.status, json, headers: res.headers };
  }

  /** Repeats `fn` while it fails in a way that is safe and sensible to repeat. */
  private async withRetries<T>(allowed: boolean, fn: () => Promise<T>): Promise<T> {
    const attempts = allowed ? 1 + this.options.maxRetries : 1;
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const again =
          err instanceof ApiError &&
          ((err.status === 0 && err.code === "network") || retryable(err.status));
        if (!again || attempt >= attempts) throw err;
        const base = Math.min(2000, 200 * 2 ** (attempt - 1));
        const wait =
          err.retryAfterSeconds !== undefined
            ? Math.min(10_000, err.retryAfterSeconds * 1000)
            : base + Math.random() * base * 0.25;
        await sleep(wait);
      }
    }
  }

  /**
   * Queues a job. Resolves once WorkMesh has SAVED it (status "queued"), not once it has run.
   *
   * Without an `idempotencyKey` there is exactly one attempt: if the connection fails you cannot
   * know whether the job exists, and repeating the call could create it twice. With a key the
   * call is repeated automatically on network errors, timeouts, 429 and 5xx, and a repeat returns
   * the original job (`replayed: true`).
   */
  async submit(input: SubmitJobInput): Promise<SubmittedJob> {
    validateSubmit(input);
    const body = {
      type: input.type,
      payload: input.payload ?? {},
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
      ...(input.runAt === undefined ? {} : { runAt: new Date(input.runAt).toISOString() }),
    };
    const keyed = input.idempotencyKey !== undefined;
    try {
      const { status, json, headers } = await this.withRetries(keyed, () =>
        this.once("POST", "/jobs", body, keyed ? { "idempotency-key": input.idempotencyKey! } : {}),
      );
      const parsed = jobSchema.safeParse(json);
      if (!parsed.success)
        throw new ApiError(0, "bad_response", "WorkMesh answered with an unexpected response.");
      return {
        ...parsed.data,
        replayed: status === 200 && headers.get("idempotent-replayed") === "true",
      };
    } catch (err) {
      if (!keyed && err instanceof ApiError && err.code === "network") {
        throw new ApiError(
          0,
          "network",
          "Could not reach WorkMesh. The job MAY have been created. Pass an idempotencyKey to submit safely and retry without creating duplicates.",
        );
      }
      throw err;
    }
  }

  /** The current state of one of your jobs. Throws ApiError 404 if it does not exist. */
  async get(id: string): Promise<Job> {
    const { json } = await this.withRetries(true, () =>
      this.once("GET", `/jobs/${encodeURIComponent(id)}`),
    );
    const parsed = jobSchema.safeParse(json);
    if (!parsed.success)
      throw new ApiError(0, "bad_response", "WorkMesh answered with an unexpected response.");
    return parsed.data;
  }
}

export class WorkMesh {
  readonly jobs: Jobs;

  constructor(options: WorkMeshOptions) {
    if (!options.apiKey) throw invalid("apiKey is required (a client key from the WorkMesh app)");
    if (!options.apiUrl) throw invalid("apiUrl is required");
    checkApiKey(options.apiKey);
    checkBaseUrl(options.apiUrl, options.allowInsecureHttp ?? false);
    this.jobs = new Jobs(
      {
        apiUrl: options.apiUrl,
        apiKey: options.apiKey,
        timeoutMs: options.timeoutMs ?? 10_000,
        maxRetries: options.maxRetries ?? 3,
      },
      options.fetch ?? ((...args) => fetch(...args)),
    );
  }
}
