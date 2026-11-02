import { randomUUID } from "node:crypto";
import { ApiError, WorkMeshClient, type ClaimedJob } from "./client.js";

/** Extra context passed to every handler. */
export interface JobContext {
  /**
   * Aborted when the API says this attempt no longer owns the job (its lease was lost and the
   * job was handed on). A well-behaved handler stops work when this fires. Note this is a hint,
   * not a guarantee: side effects already performed cannot be undone.
   */
  signal: AbortSignal;
}

export type JobHandler = (job: ClaimedJob, ctx: JobContext) => Promise<void>;

/** Throw this from a handler when retrying cannot help (bad input, rejected by a downstream). */
export class PermanentError extends Error {
  override name = "PermanentError";
}

export type LogFn = (level: "info" | "warn" | "error", msg: string, fields?: object) => void;

export interface WorkerOptions {
  /** Base URL of the WorkMesh API, e.g. http://localhost:3000 */
  apiUrl: string;
  /** A `worker` API key issued by an operator (POST /ops/keys). Required by a real server. */
  apiKey?: string;
  /** Allow a plain-http apiUrl to a remote host. Off by default: the key would travel unencrypted. */
  allowInsecureHttp?: boolean;
  name?: string;
  /** Max handlers running at once in this process. Default 1. */
  concurrency?: number;
  /** How long to wait before asking again when no work was found. Default 1000 ms. */
  pollIntervalMs?: number;
  /** Worker liveness ping while idle. Default 10 s. (Running jobs renew their own leases.) */
  heartbeatIntervalMs?: number;
  /** Base delay between attempts to deliver a result report. Default 200 ms. */
  reportRetryBaseMs?: number;
  log?: LogFn;
  /** Override for tests (fault injection). Defaults to the global fetch. */
  fetch?: typeof fetch;
}

const defaultLog: LogFn = (level, msg, fields) => {
  const line = JSON.stringify({ level, msg, ts: new Date().toISOString(), ...fields });
  (level === "error" ? console.error : console.log)(line);
};

const MAX_ERROR_LENGTH = 2000;
const REPORT_ATTEMPTS = 4;

function describeError(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text.slice(0, MAX_ERROR_LENGTH);
}

interface RunningJob {
  job: ClaimedJob;
  abort: AbortController;
  leaseLost: boolean;
}

/**
 * A worker process: registers handlers by job type, polls the API for work,
 * runs at most `concurrency` handlers at once, keeps each running job's lease
 * alive, and reports each outcome.
 *
 * Delivery is at-least-once: if this process dies, the lease expires and the job
 * runs again elsewhere, so handlers must tolerate being run twice (see docs/IDEMPOTENCY.md).
 */
export class Worker {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly client: WorkMeshClient;
  private readonly name: string;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly reportRetryBaseMs: number;
  private readonly log: LogFn;

  private workerId: string | undefined;
  private stopping = false;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly running = new Map<string, RunningJob>();
  private loopDone: Promise<void> | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private leaseTimer: NodeJS.Timeout | undefined;
  private wake: (() => void) | undefined;

  constructor(options: WorkerOptions) {
    this.client = new WorkMeshClient(
      options.apiUrl,
      10_000,
      options.fetch,
      options.apiKey,
      options.allowInsecureHttp ?? false,
    );
    this.name = options.name ?? `worker-${randomUUID().slice(0, 8)}`;
    this.concurrency = options.concurrency ?? 1;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    this.reportRetryBaseMs = options.reportRetryBaseMs ?? 200;
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
   * Graceful shutdown: stop claiming new work, let running handlers finish and report
   * (their leases keep being renewed meanwhile), then return. Jobs already claimed are
   * never abandoned by a clean stop. A process that is killed instead simply stops
   * renewing, and the API recovers its jobs when the leases expire.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.heartbeatTimer);
    this.wake?.();
    await this.loopDone;
    await Promise.allSettled([...this.inFlight]);
    clearInterval(this.leaseTimer);
    this.log("info", "worker_stopped", { workerId: this.workerId });
  }

  private async sendHeartbeat(): Promise<void> {
    try {
      await this.client.heartbeat(this.workerId!);
    } catch (err) {
      this.log("warn", "heartbeat_failed", { error: describeError(err) });
    }
  }

  /** Renews every running job's lease. Starts on the first claim, once leaseMs is known. */
  private startLeaseRenewal(leaseMs: number): void {
    if (this.leaseTimer) return;
    const everyMs = Math.max(20, Math.floor(leaseMs / 3));
    this.leaseTimer = setInterval(() => {
      for (const entry of this.running.values()) void this.renew(entry);
    }, everyMs);
  }

  private async renew(entry: RunningJob): Promise<void> {
    const { job } = entry;
    try {
      await this.client.renewLease(this.workerId!, job.id, job.attemptCount);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
        // The API says we no longer own this attempt: it was recovered/handed on.
        if (!entry.leaseLost) {
          entry.leaseLost = true;
          this.log("warn", "lease_lost", { jobId: job.id, attempt: job.attemptCount });
          entry.abort.abort(new Error("lease lost"));
        }
        return;
      }
      // Network trouble: keep trying; if it lasts past the lease, the API will recover the job.
      this.log("warn", "lease_renewal_failed", { jobId: job.id, error: describeError(err) });
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      const free = this.concurrency - this.inFlight.size;
      if (free > 0) {
        let jobs: ClaimedJob[] = [];
        try {
          const claimed = await this.client.claim(this.workerId!, free);
          jobs = claimed.jobs;
          this.startLeaseRenewal(claimed.leaseMs);
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
    const entry: RunningJob = { job, abort: new AbortController(), leaseLost: false };
    this.running.set(job.id, entry);
    const task = this.execute(entry).finally(() => {
      this.running.delete(job.id);
      this.inFlight.delete(task);
    });
    this.inFlight.add(task);
  }

  private async execute(entry: RunningJob): Promise<void> {
    const { job } = entry;
    const workerId = this.workerId!;
    const handler = this.handlers.get(job.type);
    this.log("info", "job_started", { jobId: job.id, type: job.type, attempt: job.attemptCount });
    try {
      if (!handler) throw new PermanentError(`no handler registered for job type "${job.type}"`);
      await handler(job, { signal: entry.abort.signal });
    } catch (err) {
      const error = describeError(err);
      const retryable = !(err instanceof PermanentError);
      this.log("warn", "job_handler_failed", {
        jobId: job.id,
        attempt: job.attemptCount,
        error,
        retryable,
      });
      if (entry.leaseLost) return this.skipReport(job);
      await this.report(
        () => this.client.fail(workerId, job.id, job.attemptCount, error, retryable),
        job.id,
      );
      return;
    }
    // A handler that finished after losing its lease must not report: the job now belongs
    // to a newer attempt, and the API would reject it anyway (fencing).
    if (entry.leaseLost) return this.skipReport(job);
    await this.report(() => this.client.complete(workerId, job.id, job.attemptCount), job.id);
    this.log("info", "job_finished", { jobId: job.id, attempt: job.attemptCount });
  }

  private skipReport(job: ClaimedJob): void {
    this.log("warn", "report_skipped_lease_lost", { jobId: job.id, attempt: job.attemptCount });
  }

  /**
   * Delivers a result. A lost response is indistinguishable from a lost request, so on network
   * errors and 5xx we retry; the API treats an identical repeated report as a success, which
   * makes the retry safe. A 4xx (409: no longer the owner) is final and is not retried.
   */
  private async report(send: () => Promise<void>, jobId: string): Promise<void> {
    for (let attempt = 1; attempt <= REPORT_ATTEMPTS; attempt++) {
      try {
        await send();
        return;
      } catch (err) {
        const final = err instanceof ApiError && err.status < 500;
        const lastTry = attempt === REPORT_ATTEMPTS;
        this.log(final || lastTry ? "error" : "warn", final ? "report_rejected" : "report_failed", {
          jobId,
          error: describeError(err),
          status: err instanceof ApiError ? err.status : undefined,
          tryNumber: attempt,
        });
        if (final || lastTry) return;
        await new Promise((r) => setTimeout(r, this.reportRetryBaseMs * 2 ** (attempt - 1)));
      }
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
