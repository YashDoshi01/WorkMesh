import { logError, logWarn } from "@workmesh/shared";
import type { JobLifecycle } from "./lifecycle.js";

/**
 * Periodically takes back jobs whose lease expired. Every API instance may run one:
 * correctness comes from the database (SKIP LOCKED + conditional UPDATE), not from
 * "only one reaper exists".
 */
export class LeaseReaper {
  private timer: NodeJS.Timeout | undefined;
  private current: Promise<unknown> | undefined;
  private stopped = true;

  constructor(
    private readonly lifecycle: JobLifecycle,
    private readonly intervalMs: number,
  ) {}

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
    if (!this.stopped) return;
    this.stopped = false;
    const tick = (): void => {
      this.current = this.runOnce()
        .catch((err: unknown) => {
          logError("reaper_sweep_failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          if (!this.stopped) this.timer = setTimeout(tick, this.intervalMs);
        });
    };
    this.timer = setTimeout(tick, this.intervalMs);
  }

  /** Stops scheduling and waits for a sweep already in progress. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.current;
  }
}
