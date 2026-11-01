import { z } from "zod";

/** A job as handed to a handler. Only the fields a handler needs. */
export interface ClaimedJob {
  /** Stable across every attempt of this job: use it as an idempotency key. */
  id: string;
  type: string;
  payload: Record<string, unknown>;
  /** 1 on the first execution, 2 on the first retry, ... Also the fencing token for reports. */
  attemptCount: number;
  maxAttempts: number;
}

// TypeScript types vanish at runtime, so the response is validated like any untrusted input.
const claimedJobSchema = z.object({
  id: z.uuid(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  attemptCount: z.number().int(),
  maxAttempts: z.number().int(),
});
const workerSchema = z.object({ id: z.uuid() });
const claimResponseSchema = z.object({
  jobs: z.array(claimedJobSchema),
  leaseMs: z.number().int().positive(),
});

export interface ClaimResult {
  jobs: ClaimedJob[];
  /** How long a lease lasts; the worker must renew well within this. */
  leaseMs: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Thin HTTP client for the WorkMesh worker protocol. */
export class WorkMeshClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 10_000,
    private readonly fetchImpl: typeof fetch = fetch,
    /** A `worker` API key (wm_...). Sent as a Bearer token; never logged by the SDK. */
    private readonly apiKey?: string,
  ) {}

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await this.fetchImpl(new URL(path, this.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    const json: unknown = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } } | undefined)?.error;
      throw new ApiError(
        res.status,
        err?.code ?? "unknown",
        err?.message ?? `HTTP ${res.status} from ${path}`,
      );
    }
    return json;
  }

  async register(input: {
    name: string;
    jobTypes: string[];
    concurrency: number;
  }): Promise<string> {
    return workerSchema.parse(await this.post("/workers", input)).id;
  }

  async heartbeat(workerId: string): Promise<void> {
    await this.post(`/workers/${workerId}/heartbeat`, {});
  }

  async claim(workerId: string, limit: number): Promise<ClaimResult> {
    return claimResponseSchema.parse(await this.post(`/workers/${workerId}/claim`, { limit }));
  }

  /** Renews the lease on one job. Throws ApiError 409/404 if this attempt no longer owns it. */
  async renewLease(workerId: string, jobId: string, attempt: number): Promise<void> {
    await this.post(`/jobs/${jobId}/heartbeat`, { workerId, attempt });
  }

  async complete(workerId: string, jobId: string, attempt: number): Promise<void> {
    await this.post(`/jobs/${jobId}/complete`, { workerId, attempt });
  }

  async fail(
    workerId: string,
    jobId: string,
    attempt: number,
    error: string,
    retryable: boolean,
  ): Promise<void> {
    await this.post(`/jobs/${jobId}/fail`, { workerId, attempt, error, retryable });
  }
}
