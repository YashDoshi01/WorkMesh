import { z } from "zod";

/** A job as handed to a handler. Only the fields a handler needs. */
export interface ClaimedJob {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  /** 1 on the first execution. Later attempts exist only after a retry/recovery. */
  attemptCount: number;
}

// TypeScript types vanish at runtime, so the response is validated like any untrusted input.
const claimedJobSchema = z.object({
  id: z.uuid(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  attemptCount: z.number().int(),
});
const workerSchema = z.object({ id: z.uuid() });
const claimResponseSchema = z.object({ jobs: z.array(claimedJobSchema) });

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
  ) {}

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(new URL(path, this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
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

  async claim(workerId: string, limit: number): Promise<ClaimedJob[]> {
    return claimResponseSchema.parse(await this.post(`/workers/${workerId}/claim`, { limit })).jobs;
  }

  async complete(workerId: string, jobId: string): Promise<void> {
    await this.post(`/jobs/${jobId}/complete`, { workerId });
  }

  async fail(workerId: string, jobId: string, error: string): Promise<void> {
    await this.post(`/jobs/${jobId}/fail`, { workerId, error });
  }
}
