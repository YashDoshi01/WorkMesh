import { logWarn } from "@workmesh/shared";
import { PeriodicTask } from "../util/periodic.js";
import type { JobLifecycle } from "./lifecycle.js";

/**
 * Periodically takes back jobs whose lease expired. Every API instance may run one:
 * correctness comes from the database (SKIP LOCKED + conditional UPDATE), not from
 * "only one reaper exists".
 */
export class LeaseReaper {
  private readonly loop: PeriodicTask;

  constructor(
    private readonly lifecycle: JobLifecycle,
    intervalMs: number,
  ) {
    this.loop = new PeriodicTask("reaper_sweep", () => this.runOnce(), intervalMs);
  }

  /** One sweep. Returns how many jobs were recovered. Exposed so tests can drive it directly. */
  async runOnce(): Promise<number> {
    const recovered = await this.lifecycle.recoverExpired();
    for (const job of recovered) {
      logWarn("lease_expired", {
        jobId: job.id,
        attempt: job.attemptCount,
        outcome: job.status === "queued" ? "retry_scheduled" : "failed",
        nextRunAt: job.status === "queued" ? job.runAt : undefined,
      });
    }
    return recovered.length;
  }

  start(): void {
    this.loop.start();
  }

  /** Stops scheduling and waits for a sweep already in progress. */
  stop(): Promise<void> {
    return this.loop.stop();
  }
}
