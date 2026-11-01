import { logError } from "@workmesh/shared";

/**
 * Runs `task` repeatedly with `intervalMs` between the END of one run and the START of the
 * next, so runs never overlap and a slow database cannot cause a pile-up. A failing run is
 * logged and retried next interval; it never kills the loop. `stop()` waits for a run that
 * is already in progress.
 */
export class PeriodicTask {
  private timer: NodeJS.Timeout | undefined;
  private current: Promise<unknown> | undefined;
  private stopped = true;

  constructor(
    private readonly name: string,
    private readonly task: () => Promise<unknown>,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = (): void => {
      this.current = this.task()
        .catch((err: unknown) => {
          logError(`${this.name}_failed`, {
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          if (!this.stopped) this.timer = setTimeout(tick, this.intervalMs);
        });
    };
    this.timer = setTimeout(tick, this.intervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.current;
  }
}
