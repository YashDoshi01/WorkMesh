import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { JOB_STATUSES, type JobStatus } from "../api/schemas";
import { useSession } from "../auth/auth";
import { JobLink, PageHeader, StatusBadge, Time } from "../components/bits";
import { DataView } from "../components/DataView";
import { useResource } from "../hooks/useResource";
import { formatCount } from "../lib/format";

const isStatus = (v: string | null): v is JobStatus =>
  v !== null && (JOB_STATUSES as readonly string[]).includes(v);

export function JobsPage() {
  const { api } = useSession();
  const [params, setParams] = useSearchParams();
  const status = isStatus(params.get("status")) ? (params.get("status") as JobStatus) : "";
  const type = params.get("type") ?? "";
  const scheduleId = params.get("scheduleId") ?? "";
  const workflowId = params.get("workflowId") ?? "";

  // Pagination is keyset-based and the server only gives "the page after this cursor", so we
  // remember the cursors we have walked through to be able to step back.
  const [trail, setTrail] = useState<string[]>([]); // cursors of the pages BEFORE the current one
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [typeDraft, setTypeDraft] = useState(type);

  const filterKey = JSON.stringify({ status, type, scheduleId, workflowId });
  const jobs = useResource(
    `jobs:${filterKey}:${cursor ?? ""}`,
    (signal) => api.jobs({ status, type, scheduleId, workflowId, cursor }, signal),
    // Only the newest page auto-refreshes: refreshing page 3 would shuffle rows under the reader.
    { intervalMs: cursor === undefined ? 5000 : undefined },
  );

  function update(next: Record<string, string>): void {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v) merged.set(k, v);
      else merged.delete(k);
    }
    setParams(merged);
    setTrail([]);
    setCursor(undefined);
  }

  function applyType(event: FormEvent): void {
    event.preventDefault();
    update({ type: typeDraft.trim() });
  }

  const filtered = status || type || scheduleId || workflowId;

  return (
    <>
      <PageHeader title="Jobs" />
      <div className="filter-row">
        <label>
          <span className="filter-label">Status</span>
          <select value={status} onChange={(e) => update({ status: e.target.value })}>
            <option value="">All</option>
            {JOB_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <form onSubmit={applyType} className="inline-form">
          <label>
            <span className="filter-label">Type</span>
            <input
              value={typeDraft}
              onChange={(e) => setTypeDraft(e.target.value)}
              placeholder="e.g. email.send"
            />
          </label>
          <button type="submit">Apply</button>
        </form>
        {filtered ? (
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setTypeDraft("");
              setParams(new URLSearchParams());
              setTrail([]);
              setCursor(undefined);
            }}
          >
            Clear filters
          </button>
        ) : null}
        {scheduleId ? (
          <span className="chip chip-on">schedule {scheduleId.slice(0, 8)}</span>
        ) : null}
        {workflowId ? (
          <span className="chip chip-on">workflow {workflowId.slice(0, 8)}</span>
        ) : null}
      </div>

      <DataView
        resource={jobs}
        what="jobs"
        isEmpty={(d) => d.items.length === 0}
        empty={
          filtered ? "No jobs match these filters." : "No jobs yet. Submit one to get started."
        }
      >
        {(page) => (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Job</th>
                    <th scope="col">Type</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="num">
                      Priority
                    </th>
                    <th scope="col" className="num">
                      Attempts
                    </th>
                    <th scope="col">Scheduled for</th>
                    <th scope="col">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((job) => (
                    <tr key={job.id}>
                      <td>
                        <JobLink id={job.id} />
                      </td>
                      <td>{job.type}</td>
                      <td>
                        <StatusBadge status={job.status} />
                      </td>
                      <td className="num">{job.priority}</td>
                      <td className="num">
                        {formatCount(job.attemptCount)} / {formatCount(job.maxAttempts)}
                      </td>
                      <td>
                        <Time iso={job.scheduledFor} />
                      </td>
                      <td>
                        <Time iso={job.updatedAt} relative />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <nav className="pager" aria-label="Pages">
              <button
                type="button"
                disabled={cursor === undefined}
                onClick={() => {
                  const previous = trail[trail.length - 1];
                  setTrail(trail.slice(0, -1));
                  setCursor(previous || undefined);
                }}
              >
                ← Newer
              </button>
              <span className="muted small">
                {cursor === undefined ? "Newest jobs (refreshing)" : `Page ${trail.length + 1}`}
              </span>
              <button
                type="button"
                disabled={!page.nextCursor}
                onClick={() => {
                  setTrail([...trail, cursor ?? ""]);
                  setCursor(page.nextCursor ?? undefined);
                }}
              >
                Older →
              </button>
            </nav>
          </>
        )}
      </DataView>
    </>
  );
}
