import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Job } from "../api/schemas";
import { useSession } from "../auth/auth";
import {
  ConfirmButton,
  FeedbackBanner,
  PageHeader,
  StatusBadge,
  Time,
  feedbackFromError,
  type Feedback,
} from "../components/bits";
import { DataView } from "../components/DataView";
import { useResource } from "../hooks/useResource";
import { formatDuration } from "../lib/format";

/** What an operator may do with this job, and if not, why not. The SERVER makes the real decision. */
export function jobActions(job: Job, canOperate: boolean) {
  if (!canOperate) return { cancel: false, retry: false, note: "You have read-only access." };
  if (job.workflowId) {
    return {
      cancel: false,
      retry: false,
      note: "This job is part of a workflow. Cancel the workflow to stop it; re-running part of a workflow is not supported.",
    };
  }
  if (job.status === "queued") return { cancel: true, retry: false, note: "" };
  if (job.status === "failed") return { cancel: false, retry: true, note: "" };
  if (job.status === "running") {
    return {
      cancel: false,
      retry: false,
      note: "A running job cannot be stopped safely, so it cannot be cancelled.",
    };
  }
  return { cancel: false, retry: false, note: `A ${job.status} job has no actions.` };
}

export function JobDetailPage() {
  const { id = "" } = useParams();
  const { api, canOperate } = useSession();
  const job = useResource(`job:${id}`, (s) => api.job(id, s), { intervalMs: 4000 });
  const attempts = useResource(`attempts:${id}`, (s) => api.attempts(id, s), { intervalMs: 4000 });
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [extra, setExtra] = useState(1);

  async function run(action: () => Promise<unknown>, success: string): Promise<void> {
    setFeedback(null);
    try {
      await action();
      setFeedback({ kind: "success", message: success });
    } catch (err) {
      // The server's own explanation: a refusal here means the UI's idea of the state was stale.
      setFeedback(feedbackFromError(err));
    }
    job.reload();
    attempts.reload();
  }

  return (
    <>
      <p className="breadcrumb">
        <Link to="/jobs">← All jobs</Link>
      </p>
      <PageHeader title={`Job ${id.slice(0, 8)}`} />
      <FeedbackBanner feedback={feedback} />
      <DataView resource={job} what="this job">
        {(j) => {
          const actions = jobActions(j, canOperate);
          return (
            <>
              <dl className="facts">
                <div>
                  <dt>Status</dt>
                  <dd>
                    <StatusBadge status={j.status} />
                  </dd>
                </div>
                <div>
                  <dt>Type</dt>
                  <dd>{j.type}</dd>
                </div>
                <div>
                  <dt>Priority</dt>
                  <dd>{j.priority}</dd>
                </div>
                <div>
                  <dt>Attempts</dt>
                  <dd>
                    {j.attemptCount} of {j.maxAttempts}
                  </dd>
                </div>
                <div>
                  <dt>Scheduled for</dt>
                  <dd>
                    <Time iso={j.scheduledFor} />
                  </dd>
                </div>
                <div>
                  <dt>May run from</dt>
                  <dd>
                    <Time iso={j.runAt} />
                  </dd>
                </div>
                <div>
                  <dt>Started</dt>
                  <dd>
                    <Time iso={j.startedAt} />
                  </dd>
                </div>
                <div>
                  <dt>Finished</dt>
                  <dd>
                    <Time iso={j.finishedAt} />
                  </dd>
                </div>
                {j.workflowId ? (
                  <div>
                    <dt>Workflow</dt>
                    <dd>
                      <Link to={`/workflows/${j.workflowId}`}>{j.workflowId.slice(0, 8)}</Link>
                    </dd>
                  </div>
                ) : null}
                {j.scheduleId ? (
                  <div>
                    <dt>Created by schedule</dt>
                    <dd>
                      <Link to={`/jobs?scheduleId=${j.scheduleId}`}>
                        {j.scheduleId.slice(0, 8)}
                      </Link>
                    </dd>
                  </div>
                ) : null}
              </dl>

              {j.lastError ? (
                <section aria-labelledby="err-h">
                  <h2 id="err-h">Last error</h2>
                  <pre className="error-text">{j.lastError}</pre>
                </section>
              ) : null}

              <section aria-labelledby="act-h">
                <h2 id="act-h">Actions</h2>
                <div className="actions">
                  {actions.cancel ? (
                    <ConfirmButton
                      label="Cancel job"
                      confirmLabel="Yes, cancel it"
                      danger
                      onConfirm={() => run(() => api.cancelJob(j.id), "Job cancelled.")}
                    />
                  ) : null}
                  {actions.retry ? (
                    <span className="inline-form">
                      <label>
                        <span className="filter-label">Extra attempts</span>
                        <input
                          type="number"
                          min={1}
                          max={20}
                          value={extra}
                          onChange={(e) => setExtra(Number(e.target.value))}
                        />
                      </label>
                      <ConfirmButton
                        label="Retry job"
                        confirmLabel={`Yes, retry with ${extra} more`}
                        onConfirm={() =>
                          run(() => api.retryJob(j.id, extra), "Job queued for another try.")
                        }
                      />
                    </span>
                  ) : null}
                  {!actions.cancel && !actions.retry ? (
                    <p className="muted">{actions.note}</p>
                  ) : null}
                </div>
              </section>

              <details>
                <summary>Payload</summary>
                <pre>{JSON.stringify(j.payload, null, 2)}</pre>
              </details>
            </>
          );
        }}
      </DataView>

      <section aria-labelledby="att-h">
        <h2 id="att-h">Attempts</h2>
        <DataView
          resource={attempts}
          what="attempts"
          isEmpty={(a) => a.length === 0}
          empty="No attempt has started yet."
        >
          {(rows) => (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col" className="num">
                      #
                    </th>
                    <th scope="col">Outcome</th>
                    <th scope="col">Worker</th>
                    <th scope="col">Started</th>
                    <th scope="col">Took</th>
                    <th scope="col">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => (
                    <tr key={a.attemptNumber}>
                      <td className="num">{a.attemptNumber}</td>
                      <td>
                        <StatusBadge status={a.outcome} />
                      </td>
                      <td className="mono" title={a.workerId}>
                        {a.workerId.slice(0, 8)}
                      </td>
                      <td>
                        <Time iso={a.startedAt} />
                      </td>
                      <td>
                        {a.finishedAt
                          ? formatDuration(
                              (Date.parse(a.finishedAt) - Date.parse(a.startedAt)) / 1000,
                            )
                          : "–"}
                      </td>
                      <td>{a.error ?? "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DataView>
      </section>
    </>
  );
}
