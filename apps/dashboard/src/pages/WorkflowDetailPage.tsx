import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useSession } from "../auth/auth";
import {
  ConfirmButton,
  FeedbackBanner,
  JobLink,
  PageHeader,
  StatusBadge,
  Time,
  feedbackFromError,
  type Feedback,
} from "../components/bits";
import { DataView } from "../components/DataView";
import { ProgressBar } from "../components/ProgressBar";
import { useResource } from "../hooks/useResource";
import { orderSteps } from "../lib/steps";

export function WorkflowDetailPage() {
  const { id = "" } = useParams();
  const { api, canOperate } = useSession();
  const workflow = useResource(`workflow:${id}`, (s) => api.workflow(id, s), { intervalMs: 3000 });
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function cancel(): Promise<void> {
    setFeedback(null);
    try {
      await api.cancelWorkflow(id);
      setFeedback({
        kind: "success",
        message:
          "Cancellation requested. Waiting steps are skipped and queued jobs withdrawn; jobs already running will finish.",
      });
    } catch (err) {
      setFeedback(feedbackFromError(err));
    }
    workflow.reload();
  }

  return (
    <>
      <p className="breadcrumb">
        <Link to="/workflows">← All workflows</Link>
      </p>
      <FeedbackBanner feedback={feedback} />
      <DataView resource={workflow} what="this workflow">
        {(w) => (
          <>
            <PageHeader title={w.name || `Workflow ${w.id.slice(0, 8)}`}>
              {canOperate && w.status === "running" && !w.cancelRequested ? (
                <ConfirmButton
                  label="Cancel workflow"
                  confirmLabel="Yes, cancel it"
                  danger
                  onConfirm={cancel}
                />
              ) : null}
            </PageHeader>
            <dl className="facts">
              <div>
                <dt>Status</dt>
                <dd>
                  <StatusBadge status={w.status} />
                </dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>
                  <Time iso={w.createdAt} />
                </dd>
              </div>
              <div>
                <dt>Finished</dt>
                <dd>
                  <Time iso={w.finishedAt} />
                </dd>
              </div>
              <div>
                <dt>Jobs</dt>
                <dd>
                  <Link to={`/jobs?workflowId=${w.id}`}>View all jobs in this workflow</Link>
                </dd>
              </div>
            </dl>
            {w.cancelRequested && w.status === "running" ? (
              <p className="banner banner-warning" role="status">
                Cancellation was requested. Jobs that were already running are finishing; nothing
                new will start.
              </p>
            ) : null}
            <ProgressBar progress={w.progress} />

            <h2>Steps, in the order they run</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Step</th>
                    <th scope="col">State</th>
                    <th scope="col">Waits for</th>
                    <th scope="col">Type</th>
                    <th scope="col">Job</th>
                    <th scope="col" className="num">
                      Attempts
                    </th>
                    <th scope="col">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {orderSteps(w.nodes).map((n) => (
                    <tr key={n.key}>
                      <th scope="row">{n.key}</th>
                      <td>
                        <StatusBadge status={n.state} />
                      </td>
                      <td>{n.dependsOn.length > 0 ? n.dependsOn.join(", ") : "–"}</td>
                      <td>{n.type}</td>
                      <td>
                        {n.jobId ? (
                          <JobLink id={n.jobId} />
                        ) : (
                          <span className="muted">not created yet</span>
                        )}
                      </td>
                      <td className="num">{n.attemptCount ?? "–"}</td>
                      <td>{n.lastError ?? "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </DataView>
    </>
  );
}
