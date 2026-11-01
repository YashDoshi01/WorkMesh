import { useState, type ReactNode } from "react";
import type { Stats } from "../api/schemas";
import { useSession } from "../auth/auth";
import { PageHeader, Time } from "../components/bits";
import { DataView } from "../components/DataView";
import { StackedColumns } from "../components/StackedColumns";
import { useResource } from "../hooks/useResource";
import { formatCount, formatDuration, formatRate } from "../lib/format";

const WINDOWS = [
  { minutes: 15, label: "15 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 240, label: "4 hours" },
  { minutes: 1440, label: "24 hours" },
];

function Tile({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="tile">
      <dt>{label}</dt>
      <dd className="tile-value">{value}</dd>
      {hint ? <dd className="tile-hint">{hint}</dd> : null}
    </div>
  );
}

function Distribution({ title, d }: { title: string; d: Stats["window"]["executionSeconds"] }) {
  return (
    <div className="tile">
      <dt>{title}</dt>
      {d ? (
        <dd className="tile-dist">
          <span>
            <strong>{formatDuration(d.p50)}</strong> typical (p50)
          </span>
          <span>
            <strong>{formatDuration(d.p95)}</strong> slow (p95)
          </span>
          <span>
            <strong>{formatDuration(d.max)}</strong> slowest
          </span>
        </dd>
      ) : (
        <dd className="tile-hint">Nothing measured in this window.</dd>
      )}
    </div>
  );
}

export function OverviewPage() {
  const { api } = useSession();
  const [windowMinutes, setWindowMinutes] = useState(60);
  const stats = useResource(`stats:${windowMinutes}`, (s) => api.stats(windowMinutes, s), {
    intervalMs: 5000,
  });
  const label =
    WINDOWS.find((w) => w.minutes === windowMinutes)?.label ?? `${windowMinutes} minutes`;

  return (
    <>
      <PageHeader title="Overview" />
      <div className="filter-row" role="group" aria-label="Time window">
        <span className="filter-label">Time window</span>
        {WINDOWS.map((w) => (
          <button
            key={w.minutes}
            type="button"
            aria-pressed={w.minutes === windowMinutes}
            className={w.minutes === windowMinutes ? "chip chip-on" : "chip"}
            onClick={() => setWindowMinutes(w.minutes)}
          >
            {w.label}
          </button>
        ))}
      </div>

      <DataView resource={stats} what="statistics">
        {(s) => {
          const finished = s.window.succeeded + s.window.failed;
          return (
            <>
              <p className="muted small">
                Updated <Time iso={s.generatedAt} relative /> · refreshes every 5 seconds
              </p>

              <section aria-labelledby="now-h">
                <h2 id="now-h">Right now</h2>
                <dl className="tiles">
                  <Tile
                    label="Ready to run"
                    value={formatCount(s.queue.ready)}
                    hint="waiting for a worker"
                  />
                  <Tile
                    label="Scheduled for later"
                    value={formatCount(s.queue.scheduled)}
                    hint="delayed or waiting out a retry"
                  />
                  <Tile label="Running" value={formatCount(s.queue.running)} />
                  <Tile
                    label="Longest wait"
                    value={
                      s.queue.oldestReadyAgeSeconds === null
                        ? "–"
                        : formatDuration(s.queue.oldestReadyAgeSeconds)
                    }
                    hint={
                      s.queue.oldestReadyAgeSeconds === null
                        ? "no job is waiting"
                        : "oldest job ready to run"
                    }
                  />
                  <Tile
                    label="Workers"
                    value={`${formatCount(s.workers.alive)} alive`}
                    hint={
                      s.workers.stale > 0
                        ? `${formatCount(s.workers.stale)} not responding`
                        : "none stale"
                    }
                  />
                </dl>
              </section>

              <section aria-labelledby="window-h">
                <h2 id="window-h">Last {label}</h2>
                <dl className="tiles">
                  <Tile label="Succeeded" value={formatCount(s.window.succeeded)} />
                  <Tile
                    label="Failed"
                    value={formatCount(s.window.failed)}
                    hint="retries used up"
                  />
                  <Tile
                    label="Throughput"
                    value={`${formatRate(s.window.throughputPerMinute)} /min`}
                    hint="succeeded jobs per minute"
                  />
                  <Tile
                    label="Retries"
                    value={formatCount(s.window.retries)}
                    hint="attempts after the first"
                  />
                  <Tile
                    label="Lost leases"
                    value={formatCount(s.window.leaseExpirations)}
                    hint="a worker stopped responding mid-job"
                  />
                  <Tile label="Cancelled" value={formatCount(s.window.cancelled)} />
                </dl>
                <dl className="tiles tiles-wide">
                  <Distribution
                    title="Running time (successful attempts)"
                    d={s.window.executionSeconds}
                  />
                  <Distribution
                    title="Wait before starting (first attempts)"
                    d={s.window.waitSeconds}
                  />
                </dl>
              </section>

              <section aria-labelledby="chart-h">
                <h2 id="chart-h">Jobs finished</h2>
                {finished === 0 ? (
                  <p className="state state-empty">No jobs finished in the last {label}.</p>
                ) : (
                  <StackedColumns
                    buckets={s.series}
                    bucketMinutes={s.bucketMinutes}
                    dimmed={stats.refreshing}
                  />
                )}
              </section>
            </>
          );
        }}
      </DataView>
    </>
  );
}
