import { z } from "zod";
import {
  attemptsSchema,
  auditPageSchema,
  jobPageSchema,
  jobSchema,
  meSchema,
  scheduleListSchema,
  scheduleSchema,
  statsSchema,
  workerListSchema,
  workflowDetailSchema,
  workflowListSchema,
  type Attempt,
  type AuditPage,
  type Job,
  type JobPage,
  type JobStatus,
  type Me,
  type Schedule,
  type Stats,
  type WorkerList,
  type WorkflowDetail,
  type WorkflowSummary,
} from "./schemas";

export interface FieldProblem {
  path: string;
  message: string;
}

/**
 * Anything that went wrong talking to the API, in one shape.
 *  status 0 : the request never produced a usable answer (code "network" or "bad_response")
 *  otherwise: the HTTP status and the server's own error code and message
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: FieldProblem[] = [],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface JobFilters {
  status?: JobStatus | "" | undefined;
  type?: string | undefined;
  scheduleId?: string | undefined;
  workflowId?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface SubmitJobInput {
  type: string;
  payload: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
  runAt?: string;
}

export interface ApiClientOptions {
  /** Returns the current API key, or null when signed out. Read on every request. */
  getKey: () => string | null;
  /** Called when the server says the key is no longer valid. */
  onUnauthorized?: () => void;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
}

const emptyOkSchema = z.undefined();

/** The operator-plane client. Every call is authenticated, validated and mapped to ApiError. */
export class ApiClient {
  private readonly getKey: () => string | null;
  private readonly onUnauthorized: (() => void) | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(options: ApiClientOptions) {
    this.getKey = options.getKey;
    this.onUnauthorized = options.onUnauthorized;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.baseUrl = options.baseUrl ?? "";
  }

  private async request<S extends z.ZodType>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    schema: S,
    options: { body?: unknown; signal?: AbortSignal; keyOverride?: string } = {},
  ): Promise<z.infer<S>> {
    const key = options.keyOverride ?? this.getKey();
    const headers: Record<string, string> = {};
    if (key) headers.authorization = `Bearer ${key}`;
    if (options.body !== undefined) headers["content-type"] = "application/json";

    const signals = [AbortSignal.timeout(this.timeoutMs)];
    if (options.signal) signals.push(options.signal);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/ops${path}`, {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.any(signals),
      });
    } catch (err) {
      // An abort caused by the caller (component unmounted, newer request) is not an error.
      if (options.signal?.aborted) throw err;
      throw new ApiError(
        0,
        "network",
        "Cannot reach the API. Check that it is running and try again.",
      );
    }

    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }

    if (!response.ok) {
      if (response.status === 401) this.onUnauthorized?.();
      const err = (
        json as { error?: { code?: string; message?: string; details?: unknown } } | undefined
      )?.error;
      throw new ApiError(
        response.status,
        err?.code ?? "unknown",
        err?.message ?? `The API answered HTTP ${response.status}`,
        Array.isArray(err?.details) ? (err.details as FieldProblem[]) : [],
      );
    }

    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new ApiError(0, "bad_response", "The API answered with an unexpected response shape.");
    }
    return parsed.data;
  }

  /** Checks a key without storing it. Used by the sign-in form. */
  me(keyOverride?: string, signal?: AbortSignal): Promise<Me> {
    return this.request("GET", "/me", meSchema, {
      ...(keyOverride === undefined ? {} : { keyOverride }),
      ...(signal ? { signal } : {}),
    });
  }

  stats(windowMinutes: number, signal?: AbortSignal): Promise<Stats> {
    return this.request(
      "GET",
      `/stats?windowMinutes=${windowMinutes}`,
      statsSchema,
      optional(signal),
    );
  }

  workers(signal?: AbortSignal): Promise<WorkerList> {
    return this.request("GET", "/workers", workerListSchema, optional(signal));
  }

  audit(before?: string, signal?: AbortSignal): Promise<AuditPage> {
    const qs = query({ limit: 50, before });
    return this.request("GET", `/audit${qs}`, auditPageSchema, optional(signal));
  }

  jobs(filters: JobFilters, signal?: AbortSignal): Promise<JobPage> {
    return this.request(
      "GET",
      `/jobs${query({ limit: 25, ...filters })}`,
      jobPageSchema,
      optional(signal),
    );
  }

  job(id: string, signal?: AbortSignal): Promise<Job> {
    return this.request("GET", `/jobs/${encodeURIComponent(id)}`, jobSchema, optional(signal));
  }

  async attempts(id: string, signal?: AbortSignal): Promise<Attempt[]> {
    const r = await this.request(
      "GET",
      `/jobs/${encodeURIComponent(id)}/attempts`,
      attemptsSchema,
      optional(signal),
    );
    return r.items;
  }

  submitJob(input: SubmitJobInput): Promise<Job> {
    return this.request("POST", "/jobs", jobSchema, { body: input });
  }

  cancelJob(id: string): Promise<Job> {
    return this.request("POST", `/jobs/${encodeURIComponent(id)}/cancel`, jobSchema, { body: {} });
  }

  retryJob(id: string, attempts: number): Promise<Job> {
    return this.request("POST", `/jobs/${encodeURIComponent(id)}/retry`, jobSchema, {
      body: { attempts },
    });
  }

  async workflows(signal?: AbortSignal): Promise<WorkflowSummary[]> {
    const r = await this.request(
      "GET",
      "/workflows?limit=50",
      workflowListSchema,
      optional(signal),
    );
    return r.items;
  }

  workflow(id: string, signal?: AbortSignal): Promise<WorkflowDetail> {
    return this.request(
      "GET",
      `/workflows/${encodeURIComponent(id)}`,
      workflowDetailSchema,
      optional(signal),
    );
  }

  cancelWorkflow(id: string): Promise<WorkflowDetail> {
    return this.request(
      "POST",
      `/workflows/${encodeURIComponent(id)}/cancel`,
      workflowDetailSchema,
      {
        body: {},
      },
    );
  }

  async schedules(signal?: AbortSignal): Promise<Schedule[]> {
    const r = await this.request(
      "GET",
      "/schedules?limit=200",
      scheduleListSchema,
      optional(signal),
    );
    return r.items;
  }

  setScheduleEnabled(id: string, enabled: boolean): Promise<Schedule> {
    return this.request("PATCH", `/schedules/${encodeURIComponent(id)}`, scheduleSchema, {
      body: { enabled },
    });
  }

  async deleteSchedule(id: string): Promise<void> {
    await this.request("DELETE", `/schedules/${encodeURIComponent(id)}`, emptyOkSchema);
  }
}

const optional = (signal: AbortSignal | undefined): { signal?: AbortSignal } =>
  signal ? { signal } : {};

/** `?a=1&b=2` from the defined, non-empty values; "" when there are none. */
export function query(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}
