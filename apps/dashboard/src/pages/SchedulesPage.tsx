import { useState } from "react";
import { Link } from "react-router-dom";
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
import { formatDateTime } from "../lib/format";

export function SchedulesPage() {
  const { api, canOperate } = useSession();
  const schedules = useResource("schedules", (s) => api.schedules(s), { intervalMs: 10_000 });
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function run(action: () => Promise<unknown>, success: string): Promise<void> {
    setFeedback(null);
    try {
      await action();
      setFeedback({ kind: "success", message: success });
    } catch (err) {
      setFeedback(feedbackFromError(err));
    }
    schedules.reload();
  }

  return (
    <>
      <PageHeader title="Schedules" />
      <FeedbackBanner feedback={feedback} />
      <DataView
        resource={schedules}
        what="schedules"
        isEmpty={(items) => items.length === 0}
        empty="No schedules yet. Create one with POST /schedules; see the README."
      >
        {(items) => (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">State</th>
                  <th scope="col">When</th>
                  <th scope="col">Runs</th>
                  <th scope="col">Next run</th>
                  <th scope="col">Last run</th>
                  {canOperate ? <th scope="col">Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {items.map((s) => (
                  <tr key={s.id}>
                    <th scope="row">
                      <Link to={`/jobs?scheduleId=${s.id}`} title="Jobs this schedule created">
                        {s.name}
                      </Link>
                    </th>
                    <td>
                      <StatusBadge status={s.enabled ? "enabled" : "disabled"} />
                      {s.lastError ? (
                        <p className="error-text small" role="note">
                          Disabled after an error: {s.lastError}
                        </p>
                      ) : null}
                    </td>
                    <td>
                      <code>{s.cron}</code> <span className="muted">({s.timezone})</span>
                    </td>
                    <td>{s.jobType}</td>
                    <td>
                      {s.enabled ? (
                        <time dateTime={s.nextRunAt} title={`${s.nextRunAt} (UTC)`}>
                          {formatDateTime(s.nextRunAt, s.timezone)}
                        </time>
                      ) : (
                        "–"
                      )}
                    </td>
                    <td>
                      <Time iso={s.lastRunAt} relative />
                    </td>
                    {canOperate ? (
                      <td>
                        <span className="actions">
                          <button
                            type="button"
                            onClick={() =>
                              void run(
                                () => api.setScheduleEnabled(s.id, !s.enabled),
                                s.enabled ? `Disabled ${s.name}.` : `Enabled ${s.name}.`,
                              )
                            }
                          >
                            {s.enabled ? "Disable" : "Enable"}
                          </button>
                          <ConfirmButton
                            label="Delete"
                            confirmLabel="Yes, delete"
                            danger
                            onConfirm={() =>
                              run(() => api.deleteSchedule(s.id), `Deleted ${s.name}.`)
                            }
                          />
                        </span>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DataView>
    </>
  );
}
