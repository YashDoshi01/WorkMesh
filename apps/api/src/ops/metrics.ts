import type { Stats } from "./queries.js";

/**
 * Renders the queue's health in the Prometheus text exposition format (version 0.0.4).
 *
 * Every number comes from the DATABASE (via OpsQueries.stats), not from counters inside the API
 * process. That is deliberate: with several API instances behind a load balancer, a scrape lands
 * on a random instance, and per-process counters would report a different fraction of the traffic
 * every time. Database-derived values are the same whichever instance answers.
 *
 * The price: values over a time window are GAUGES ("how many in the last N minutes"), not
 * ever-increasing counters, so use them with `avg_over_time`/alerts, not `rate()`.
 */

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

type Labels = Record<string, string>;

function line(name: string, value: number, labels: Labels = {}): string {
  const body = Object.entries(labels)
    .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
    .join(",");
  return `${name}${body ? `{${body}}` : ""} ${Number.isFinite(value) ? value : 0}`;
}

export function renderMetrics(stats: Stats): string {
  const w = stats.window;
  const window = { window_minutes: String(stats.windowMinutes) };
  const out: string[] = [];
  const metric = (name: string, help: string, rows: string[]): void => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, ...rows);
  };

  metric("workmesh_queue_jobs", "Jobs waiting or running right now, by state.", [
    line("workmesh_queue_jobs", stats.queue.ready, { state: "ready" }),
    line("workmesh_queue_jobs", stats.queue.scheduled, { state: "scheduled" }),
    line("workmesh_queue_jobs", stats.queue.running, { state: "running" }),
  ]);
  metric(
    "workmesh_queue_oldest_ready_age_seconds",
    "How long the longest-waiting ready job has waited (0 if none is ready). The queue-latency SLI.",
    [line("workmesh_queue_oldest_ready_age_seconds", stats.queue.oldestReadyAgeSeconds ?? 0)],
  );
  metric("workmesh_workers", "Registered workers by health (alive = heartbeat within 30 s).", [
    line("workmesh_workers", stats.workers.alive, { health: "alive" }),
    line("workmesh_workers", stats.workers.stale, { health: "stale" }),
  ]);
  metric("workmesh_window_jobs_finished", "Jobs that finished in the window, by outcome.", [
    line("workmesh_window_jobs_finished", w.succeeded, { ...window, outcome: "succeeded" }),
    line("workmesh_window_jobs_finished", w.failed, { ...window, outcome: "failed" }),
    line("workmesh_window_jobs_finished", w.cancelled, { ...window, outcome: "cancelled" }),
  ]);
  metric("workmesh_window_retries", "Attempts beyond the first that started in the window.", [
    line("workmesh_window_retries", w.retries, window),
  ]);
  metric("workmesh_window_lease_expirations", "Leases that expired in the window.", [
    line("workmesh_window_lease_expirations", w.leaseExpirations, window),
  ]);
  metric("workmesh_window_throughput_per_minute", "Succeeded jobs per minute over the window.", [
    line("workmesh_window_throughput_per_minute", w.throughputPerMinute, window),
  ]);

  const distribution = (
    name: string,
    help: string,
    d: { p50: number; p95: number; max: number } | null,
  ): void => {
    metric(
      name,
      help,
      d
        ? [
            line(name, d.p50, { ...window, quantile: "0.5" }),
            line(name, d.p95, { ...window, quantile: "0.95" }),
            line(name, d.max, { ...window, quantile: "1" }),
          ]
        : [],
    );
  };
  distribution(
    "workmesh_window_execution_seconds",
    "How long successful attempts ran in the window (absent if none finished).",
    w.executionSeconds,
  );
  distribution(
    "workmesh_window_wait_seconds",
    "Enqueue-to-start latency of first attempts that started in the window (absent if none).",
    w.waitSeconds,
  );
  return `${out.join("\n")}\n`;
}
