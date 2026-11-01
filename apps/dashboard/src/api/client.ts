import { z } from "zod";
import {
  attemptsSchema,
  auditPageSchema,
  createdInviteSchema,
  createdKeySchema,
  inviteInfoSchema,
  inviteListSchema,
  inviteSchema,
  jobPageSchema,
  jobSchema,
  keyListSchema,
  keySchema,
  memberListSchema,
  memberSchema,
  meSchema,
  okSchema,
  sessionSchema,
  scheduleListSchema,
  scheduleSchema,
  statsSchema,
  workerListSchema,
  workflowDetailSchema,
  workflowListSchema,
  type ApiKey,
  type Attempt,
  type AuditPage,
  type CreatedInvite,
  type CreatedKey,
  type Invite,
  type InviteInfo,
  type Job,
  type JobPage,
  type JobStatus,
  type Me,
  type Member,
  type Role,
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

export interface CreateScheduleInput {
  name: string;
  cron: string;
  timezone?: string;
  jobType: string;
  payload?: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
  enabled?: boolean;
}

export interface CreateKeyInput {
  kind: "client" | "worker";
  name: string;
  jobTypes?: string[];
  expiresInDays?: number;
}

export interface ApiClientOptions {
  /** Called when the server says the session is no longer valid (expired, signed out elsewhere). */
  onUnauthorized?: () => void;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
}

const emptyOkSchema = z.undefined();

/**
 * The customer API client. The session lives in an HttpOnly cookie that the browser sends by
 * itself, so no credential is ever held in JavaScript. Every state-changing request carries the
 * custom header the server requires against cross-site request forgery.
 */
export class ApiClient {
  private readonly onUnauthorized: (() => void) | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(options: ApiClientOptions = {}) {
    this.onUnauthorized = options.onUnauthorized;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.baseUrl = options.baseUrl ?? "";
  }

  private async request<S extends z.ZodType>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    schema: S,
    options: { body?: unknown; signal?: AbortSignal; quiet401?: boolean } = {},
  ): Promise<z.infer<S>> {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET") headers["x-workmesh-csrf"] = "1";

    const signals = [AbortSignal.timeout(this.timeoutMs)];
    if (options.signal) signals.push(options.signal);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/app${path}`, {
        method,
        headers,
        credentials: "same-origin",
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.any(signals),
      });
    } catch (err) {
      // An abort caused by the caller (component unmounted, newer request) is not an error.
      if (options.signal?.aborted) throw err;
      throw new ApiError(
        0,
        "network",
        "Cannot reach the service. Check your connection and try again.",
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
      // A 401 on a sign-in attempt just means wrong credentials; elsewhere it means the session ended.
      if (response.status === 401 && !options.quiet401) this.onUnauthorized?.();
      const err = (
        json as { error?: { code?: string; message?: string; details?: unknown } } | undefined
      )?.error;
      throw new ApiError(
        response.status,
        err?.code ?? "unknown",
        err?.message ?? `The service answered HTTP ${response.status}`,
        Array.isArray(err?.details) ? (err.details as FieldProblem[]) : [],
      );
    }

    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new ApiError(
        0,
        "bad_response",
        "The service answered with an unexpected response shape.",
      );
    }
    return parsed.data;
  }

  // ---------------------------------------------------------------- authentication
  /** Who is signed in, or null for a visitor. The server answers 200 either way, so a visitor's
   *  browser does not log a failed request on every page load. */
  async session(signal?: AbortSignal): Promise<Me | null> {
    const r = await this.request("GET", "/auth/session", sessionSchema, optional(signal));
    return r.me;
  }

  signup(input: { orgName: string; name: string; email: string; password: string }): Promise<Me> {
    return this.request("POST", "/auth/signup", meSchema, { body: input, quiet401: true });
  }

  login(input: { email: string; password: string }): Promise<Me> {
    return this.request("POST", "/auth/login", meSchema, { body: input, quiet401: true });
  }

  async logout(): Promise<void> {
    await this.request("POST", "/auth/logout", okSchema, { body: {}, quiet401: true });
  }

  inviteInfo(token: string): Promise<InviteInfo> {
    return this.request("POST", "/auth/invite-info", inviteInfoSchema, {
      body: { token },
      quiet401: true,
    });
  }

  acceptInvite(input: { token: string; name: string; password: string }): Promise<Me> {
    return this.request("POST", "/auth/accept-invite", meSchema, { body: input, quiet401: true });
  }

  async changePassword(input: { currentPassword: string; newPassword: string }): Promise<void> {
    await this.request("POST", "/auth/change-password", okSchema, { body: input });
  }

  // ------------------------------------------------------------------------- reads
  stats(windowMinutes: number, signal?: AbortSignal): Promise<Stats> {
    return this.request(
      "GET",
      `/overview?windowMinutes=${windowMinutes}`,
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

  async schedules(signal?: AbortSignal): Promise<Schedule[]> {
    const r = await this.request(
      "GET",
      "/schedules?limit=200",
      scheduleListSchema,
      optional(signal),
    );
    return r.items;
  }

  async keys(signal?: AbortSignal): Promise<ApiKey[]> {
    return (await this.request("GET", "/keys", keyListSchema, optional(signal))).items;
  }

  async members(signal?: AbortSignal): Promise<Member[]> {
    return (await this.request("GET", "/members", memberListSchema, optional(signal))).items;
  }

  async invites(signal?: AbortSignal): Promise<Invite[]> {
    return (await this.request("GET", "/invites", inviteListSchema, optional(signal))).items;
  }

  // ------------------------------------------------------------------ admin changes
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

  cancelWorkflow(id: string): Promise<WorkflowDetail> {
    return this.request(
      "POST",
      `/workflows/${encodeURIComponent(id)}/cancel`,
      workflowDetailSchema,
      { body: {} },
    );
  }

  createSchedule(input: CreateScheduleInput): Promise<Schedule> {
    return this.request("POST", "/schedules", scheduleSchema, { body: input });
  }

  setScheduleEnabled(id: string, enabled: boolean): Promise<Schedule> {
    return this.request("PATCH", `/schedules/${encodeURIComponent(id)}`, scheduleSchema, {
      body: { enabled },
    });
  }

  async deleteSchedule(id: string): Promise<void> {
    await this.request("DELETE", `/schedules/${encodeURIComponent(id)}`, emptyOkSchema);
  }

  createKey(input: CreateKeyInput): Promise<CreatedKey> {
    return this.request("POST", "/keys", createdKeySchema, { body: input });
  }

  revokeKey(id: string): Promise<ApiKey> {
    return this.request("POST", `/keys/${encodeURIComponent(id)}/revoke`, keySchema, { body: {} });
  }

  createInvite(input: { email: string; role: Role }): Promise<CreatedInvite> {
    return this.request("POST", "/invites", createdInviteSchema, { body: input });
  }

  revokeInvite(id: string): Promise<Invite> {
    return this.request("POST", `/invites/${encodeURIComponent(id)}/revoke`, inviteSchema, {
      body: {},
    });
  }

  changeRole(id: string, role: Role): Promise<Member> {
    return this.request("PATCH", `/members/${encodeURIComponent(id)}`, memberSchema, {
      body: { role },
    });
  }

  async removeMember(id: string): Promise<void> {
    await this.request("DELETE", `/members/${encodeURIComponent(id)}`, emptyOkSchema);
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
