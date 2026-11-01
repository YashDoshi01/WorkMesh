import { randomUUID } from "node:crypto";
import { ApiError, WorkMeshClient, type ClaimedJob } from "./client.js";

export type JobHandler = (job: ClaimedJob) => Promise<void>;

export type LogFn = (level: "info" | "warn" | "error", msg: string, fields?: object) => void;

export interface WorkerOptions {
  /** Base URL of the WorkMesh API, e.g. http://localhost:3000 */
  apiUrl: string;
  name?: string;
  /** Max handlers running at once in this process. Default 1. */
  concurrency?: number;
  /** How long to wait before asking again when no work was found. Default 1000 ms. */
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  log?: LogFn;
}

const defaultLog: LogFn = (level, msg, fields) => {
  const line = JSON.stringify({ level, msg, ts: new Date().toISOString(), ...fields });
  (level === "error" ? console.error : console.log)(line);
};

const MAX_ERROR_LENGTH = 2000;

function describeError(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text.slice(0, MAX_ERROR_LENGTH);
}

/**
 * A worker process: registers handlers by job type, polls the API for work,
 * runs at most `concurrency` handlers at once, and reports each outcome.
 *
 * Delivery is at-least-once (see docs): a crash between finishing a handler and
 * reporting it leaves the job `running`. Recovery arrives with leases in Phase 3.
 */
export class Worker {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly client: WorkMeshClient;
  private readonly name: string;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly log: LogFn;

  private workerId: string | undefined;
  private stopping = false;
  private readonly inFlight = new Set<Promise<void>>();
  private loopDone: Promise<void> | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private wake: (() => void) | undefined;

  constructor(options: WorkerOptions) {
    this.client = new WorkMeshClient(options.apiUrl);
    this.name = options.name ?? `worker-${randomUUID().slice(0, 8)}`;
    this.concurrency = options.concurrency ?? 1;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    this.log = options.log ?? defaultLog;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1) {
      throw new RangeError("concurrency must be a positive integer");
    }
  }

  /** The id the API assigned at start(); undefined before then. */
  get id(): string | undefined {
    return this.workerId;
  }

  /** Maps a job type to the local function that performs it. Call before start(). */
  register(jobType: string, handler: JobHandler): this {
    if (this.workerId) throw new Error("register() must be called before start()");
    this.handlers.set(jobType, handler);
    return this;
  }

  /** Registers this process with the API, then begins polling in the background. */
  async start(): Promise<void> {
    if (this.handlers.size === 0) throw new Error("register at least one handler before start()");
    if (this.workerId) throw new Error("worker already started");
    this.workerId = await this.client.register({
      name: this.name,
      jobTypes: [...this.handlers.keys()],
      concurrency: this.concurrency,
    });
    this.log("info", "worker_started", {
      workerId: this.workerId,
      jobTypes: [...this.handlers.keys()],
      concurrency: this.concurrency,
    });
    this.heartbeatTimer = setInterval(() => void this.sendHeartbeat(), this.heartbeatIntervalMs);
    this.loopDone = this.loop();
  }

  /**
   * Graceful shutdown: stop claiming new work, let running handlers finish and report,
   * then return. Jobs already claimed are never abandoned by a clean stop.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.heartbeatTimer);
    this.wake?.();
    await this.loopDone;
    await Promise.allSettled([...this.inFlight]);
    this.log("info", "worker_stopped", { workerId: this.workerId });
  }

  private async sendHeartbeat(): Promise<void> {
    try {
      await this.client.heartbeat(this.workerId!);
    } catch (err) {
      this.log("warn", "heartbeat_failed", { error: describeError(err) });
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      const free = this.concurrency - this.inFlight.size;
      if (free > 0) {
        let jobs: ClaimedJob[] = [];
        try {
          jobs = await this.client.claim(this.workerId!, free);
        } catch (err) {
          this.log("error", "claim_failed", { error: describeError(err) });
        }
        for (const job of jobs) this.launch(job);
        // Claimed fewer than asked for => the queue is (momentarily) empty: back off.
        if (jobs.length < free) await this.sleep(this.pollIntervalMs);
      } else {
        // All slots busy: wait for one to free up (or for stop()).
        await Promise.race([...this.inFlight, this.sleep(this.pollIntervalMs)]);
      }
    }
  }

  private launch(job: ClaimedJob): void {
    const task = this.execute(job).finally(() => this.inFlight.delete(task));
    this.inFlight.add(task);
  }

  private async execute(job: ClaimedJob): Promise<void> {
    const workerId = this.workerId!;
    const handler = this.handlers.get(job.type);
    this.log("info", "job_started", { jobId: job.id, type: job.type, attempt: job.attemptCount });
    try {
      if (!handler) throw new Error(`no handler registered for job type "${job.type}"`);
      await handler(job);
    } catch (err) {
      const error = describeError(err);
      this.log("warn", "job_handler_failed", { jobId: job.id, error });
      await this.report(() => this.client.fail(workerId, job.id, error), job.id);
      return;
    }
    await this.report(() => this.client.complete(workerId, job.id), job.id);
    this.log("info", "job_finished", { jobId: job.id });
  }

  /** Reporting can fail (network, or 409 if we no longer own the job). Never swallow silently. */
  private async report(send: () => Promise<void>, jobId: string): Promise<void> {
    try {
      await send();
    } catch (err) {
      this.log("error", "report_failed", {
        jobId,
        error: describeError(err),
        status: err instanceof ApiError ? err.status : undefined,
      });
    }
  }

  private sleep(ms: number): Promise<void> {
    // stop() may have been requested while a claim request was in flight.
    if (this.stopping) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        if (this.wake === done) this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }
}
