import { useState, type FormEvent } from "react";
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
import { Field, problems } from "../components/Field";
import { Icon } from "../components/Icon";
import { Modal } from "../components/Modal";
import { useResource } from "../hooks/useResource";
import { formatDateTime } from "../lib/format";

function CreateScheduleDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const { api } = useSession();
  const [name, setName] = useState("");
  const [cron, setCron] = useState("");
  const [timezone, setTimezone] = useState("UTC");
  const [jobType, setJobType] = useState("");
  const [payload, setPayload] = useState("{}");
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string | null>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setFields({});
    setGeneral(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload || "{}");
    } catch {
      setFields({ payload: "must be valid JSON" });
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setFields({ payload: "must be a JSON object, like {}" });
      return;
    }
    setBusy(true);
    try {
      await api.createSchedule({
        name: name.trim(),
        cron: cron.trim(),
        timezone: timezone.trim() || "UTC",
        jobType: jobType.trim(),
        payload: parsed as Record<string, unknown>,
      });
      onCreated();
      onClose();
    } catch (err) {
      const p = problems(err);
      setFields(p.fields);
      setGeneral(p.general);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="New schedule" onClose={onClose} closable={!busy}>
      <form className="form" onSubmit={(e) => void submit(e)} style={{ marginTop: 14 }}>
        {general ? (
          <p role="alert" className="banner banner-error">
            {general}
          </p>
        ) : null}
        <Field
          label="Name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={fields.name}
        />
        <Field
          label="When (cron)"
          required
          value={cron}
          onChange={(e) => setCron(e.target.value)}
          error={fields.cron}
          placeholder="0 9 * * 1-5"
          hint="Five fields: minute hour day month weekday. Example: 0 9 * * 1-5 is 09:00 on weekdays."
        />
        <div className="form-row">
          <div style={{ flex: 1, minWidth: 140 }}>
            <Field
              label="Time zone"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              error={fields.timezone}
              hint="For example UTC or America/New_York."
            />
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <Field
              label="Job type"
              required
              value={jobType}
              onChange={(e) => setJobType(e.target.value)}
              error={fields.jobType}
              placeholder="report.build"
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="schedule-payload">Payload (JSON)</label>
          <textarea
            id="schedule-payload"
            rows={3}
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            aria-invalid={fields.payload ? true : undefined}
          />
          {fields.payload ? (
            <p role="alert" className="field-error">
              {fields.payload}
            </p>
          ) : null}
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            disabled={busy || !name.trim() || !cron.trim() || !jobType.trim()}
          >
            {busy ? "Creating…" : "Create schedule"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function SchedulesPage() {
  const { api, canOperate } = useSession();
  const schedules = useResource("schedules", (s) => api.schedules(s), { intervalMs: 10_000 });
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [creating, setCreating] = useState(false);

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
      <PageHeader title="Schedules">
        {canOperate ? (
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            <Icon name="plus" /> New schedule
          </button>
        ) : null}
      </PageHeader>
      <FeedbackBanner feedback={feedback} />
      <DataView
        resource={schedules}
        what="schedules"
        isEmpty={(items) => items.length === 0}
        empty={
          canOperate
            ? "No schedules yet. Create one to run a job automatically on a cron schedule."
            : "No schedules yet. An admin can create them."
        }
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
      {creating ? (
        <CreateScheduleDialog
          onClose={() => setCreating(false)}
          onCreated={() => schedules.reload()}
        />
      ) : null}
    </>
  );
}
