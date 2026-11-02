import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Stats } from "../api/schemas";
import { useSession } from "../auth/auth";
import { PageHeader, Time } from "../components/bits";
import { DataView } from "../components/DataView";
import { Icon, type IconName } from "../components/Icon";
import { Sparkline } from "../components/Sparkline";
import { StackedColumns } from "../components/StackedColumns";
import { useResource } from "../hooks/useResource";
import { formatCount, formatDuration, formatRate } from "../lib/format";

const WINDOWS = [
  { minutes: 15, label: "15 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 240, label: "4 hours" },
  { minutes: 1440, label: "24 hours" },
];

function Tile({
  label,
  value,
  hint,
  icon,
  tone = "brand",
  trend,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: IconName;
  tone?: "brand" | "good" | "bad" | "warn";
  trend?: ReactNode;
}) {
  return (
    <div className="tile">
      <dt>{label}</dt>
      <dd className="tile-value">{value}</dd>
      {hint ? <dd className="tile-hint">{hint}</dd> : null}
      {trend}
      {icon ? (
        <span className={`tile-icon tone-${tone}`} aria-hidden="true">
          <Icon name={icon} />
        </span>
      ) : null}
    </div>
  );
}

const greeting = (name: string): string => {
  const hour = new Date().getHours();
  const part = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return `${part}, ${name.split(/\s+/)[0] ?? name}`;
};

function Distribution({ title, d }: { title: string; d: Stats["window"]["executionSeconds"] }) {
  const rows = d
    ? ([
        ["typical (p50)", d.p50],
        ["slow (p95)", d.p95],
        ["slowest", d.max],
      ] as const)
    : [];
  const top = d ? Math.max(d.max, 0.001) : 1;
  return (
    <div className="tile">
      <dt>{title}</dt>
      {d ? (
        <dd className="dist-bars">
          {rows.map(([name, value]) => (
            <span className="dist-row" key={name}>
              <span>{name}</span>
              <span className="dist-track" aria-hidden="true">
                <span
                  className="dist-fill"
                  style={{ width: `${Math.max(3, (value / top) * 100)}%` }}
                />
              </span>
              <strong>{formatDuration(value)}</strong>
            </span>
          ))}
        </dd>
      ) : (
        <dd className="tile-hint">Nothing measured in this window.</dd>
      )}
    </div>
  );
}

/** Shown to a brand-new organisation, until its first job or worker appears. */
function GetStarted({ canOperate }: { canOperate: boolean }) {
  return (
    <section className="card" aria-labelledby="start-h" style={{ marginBottom: 18 }}>
      <h2 id="start-h">Get started</h2>
      <p className="muted">Three steps to your first job:</p>
      <ol className="steps">
        <li>
          <span className="n" aria-hidden="true">
            1
          </span>
          <div>
            <h3>
              <Link to="/keys">Create API keys</Link>
            </h3>
            <p>A client key for your app and a worker key for your worker.</p>
          </div>
        </li>
        <li>
          <span className="n" aria-hidden="true">
            2
          </span>
          <div>
            <h3>Run a worker</h3>
            <p>
              Start a worker with your worker key as <code>WORKMESH_API_KEY</code>. It appears under{" "}
              <Link to="/workers">Workers</Link>.
            </p>
          </div>
        </li>
        <li>
          <span className="n" aria-hidden="true">
            3
          </span>
          <div>
            <h3>{canOperate ? <Link to="/submit">Submit a job</Link> : "Submit a job"}</h3>
            <p>Send one from your app, or submit a test job from the dashboard.</p>
          </div>
        </li>
      </ol>
    </section>
  );
}

export function OverviewPage() {
  const { api, canOperate, me } = useSession();
  const [windowMinutes, setWindowMinutes] = useState(60);
  const stats = useResource(`stats:${windowMinutes}`, (s) => api.stats(windowMinutes, s), {
    intervalMs: 5000,
  });
  const label =
    WINDOWS.find((w) => w.minutes === windowMinutes)?.label ?? `${windowMinutes} minutes`;

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={
          me ? `${greeting(me.user.name)}. Here is how ${me.account.name} is doing.` : undefined
        }
      />
      <div className="filter-row" role="group" aria-label="Time window">
        <span className="filter-label">Time window</span>
        <div className="segmented">
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
      </div>

      <DataView resource={stats} what="statistics">
        {(s) => {
          const finished = s.window.succeeded + s.window.failed;
          const brandNew =
            s.workers.alive + s.workers.stale === 0 &&
            s.queue.queued + s.queue.running === 0 &&
            finished + s.window.cancelled === 0;
          return (
            <>
              {brandNew ? <GetStarted canOperate={canOperate} /> : null}
              <p className="muted small">
                <span className="live-dot" aria-hidden="true" />
                Updated <Time iso={s.generatedAt} relative /> · refreshes every 5 seconds
              </p>

              <section aria-labelledby="now-h">
                <h2 id="now-h">Right now</h2>
                <dl className="tiles tiles-5">
                  <Tile
                    label="Ready to run"
                    icon="jobs"
                    value={formatCount(s.queue.ready)}
                    hint="waiting for a worker"
                  />
                  <Tile
                    label="Scheduled for later"
                    icon="schedules"
                    tone="warn"
                    value={formatCount(s.queue.scheduled)}
                    hint="delayed or waiting out a retry"
                  />
                  <Tile label="Running" icon="activity" value={formatCount(s.queue.running)} />
                  <Tile
                    label="Longest wait"
                    icon="timer"
                    tone="warn"
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
                    icon="workers"
                    tone="good"
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
                <dl className="tiles tiles-6">
                  <Tile
                    label="Succeeded"
                    icon="success"
                    tone="good"
                    value={formatCount(s.window.succeeded)}
                    trend={<Sparkline values={s.series.map((b) => b.succeeded)} />}
                  />
                  <Tile
                    label="Failed"
                    icon="alert"
                    tone="bad"
                    value={formatCount(s.window.failed)}
                    hint="retries used up"
                    trend={<Sparkline bad values={s.series.map((b) => b.failed)} />}
                  />
                  <Tile
                    label="Throughput"
                    icon="bolt"
                    value={`${formatRate(s.window.throughputPerMinute)} /min`}
                    hint="succeeded jobs per minute"
                  />
                  <Tile
                    label="Retries"
                    icon="refresh"
                    tone="warn"
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
