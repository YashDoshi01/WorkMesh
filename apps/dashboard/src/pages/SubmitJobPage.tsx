import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import type { Job } from "../api/schemas";
import type { SubmitJobInput } from "../api/client";
import { useSession } from "../auth/auth";
import { FeedbackBanner, PageHeader, feedbackFromError, type Feedback } from "../components/bits";

const MAX_PAYLOAD_BYTES = 64 * 1024;

/**
 * Turns the form fields into a request, or says what is wrong. This is a convenience for the
 * person typing; the server validates everything again and its answer is what counts.
 */
export function buildJobRequest(fields: {
  type: string;
  payload: string;
  priority: string;
  maxAttempts: string;
  runAt: string;
}): { ok: true; request: SubmitJobInput } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const type = fields.type.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(type)) {
    problems.push(
      "Type must be 1-100 characters: lowercase letters, digits, '.', '_' or '-', starting with a letter or digit.",
    );
  }

  let payload: Record<string, unknown> = {};
  const text = fields.payload.trim() || "{}";
  if (new TextEncoder().encode(text).length > MAX_PAYLOAD_BYTES) {
    problems.push("Payload is larger than 64 KiB.");
  } else {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        problems.push('Payload must be a JSON object, like {"to": "a@b.c"}.');
      } else {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      problems.push("Payload is not valid JSON.");
    }
  }

  const priority = Number(fields.priority);
  if (!Number.isInteger(priority) || priority < 0 || priority > 100) {
    problems.push("Priority must be a whole number from 0 to 100.");
  }
  const maxAttempts = Number(fields.maxAttempts);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
    problems.push("Attempts must be a whole number from 1 to 20.");
  }

  let runAt: string | undefined;
  if (fields.runAt) {
    const date = new Date(fields.runAt);
    if (Number.isNaN(date.getTime())) problems.push("Run-at is not a valid date and time.");
    else runAt = date.toISOString();
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    request: { type, payload, priority, maxAttempts, ...(runAt ? { runAt } : {}) },
  };
}

export function SubmitJobPage() {
  const { api, canOperate } = useSession();
  const [type, setType] = useState("");
  const [payload, setPayload] = useState("{}");
  const [priority, setPriority] = useState("0");
  const [maxAttempts, setMaxAttempts] = useState("3");
  const [runAt, setRunAt] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [created, setCreated] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setFeedback(null);
    setCreated(null);
    const built = buildJobRequest({ type, payload, priority, maxAttempts, runAt });
    if (!built.ok) {
      setProblems(built.problems);
      return;
    }
    setProblems([]);
    setBusy(true);
    try {
      setCreated(await api.submitJob(built.request));
    } catch (err) {
      setFeedback(feedbackFromError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Submit a job" />
      {canOperate ? null : (
        <p className="banner banner-info" role="note">
          Viewers cannot submit jobs.
        </p>
      )}
      <form className="form" onSubmit={(e) => void submit(e)} noValidate>
        <label>
          Job type
          <input value={type} onChange={(e) => setType(e.target.value)} placeholder="email.send" />
        </label>
        <label>
          Payload (JSON object)
          <textarea
            rows={6}
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            spellCheck={false}
          />
        </label>
        <div className="form-row">
          <label>
            Priority (0-100)
            <input type="number" value={priority} onChange={(e) => setPriority(e.target.value)} />
          </label>
          <label>
            Max attempts
            <input
              type="number"
              value={maxAttempts}
              onChange={(e) => setMaxAttempts(e.target.value)}
            />
          </label>
          <label>
            Run at (optional, your local time)
            <input type="datetime-local" value={runAt} onChange={(e) => setRunAt(e.target.value)} />
          </label>
        </div>

        {problems.length > 0 ? (
          <div className="banner banner-error" role="alert">
            <p>Please fix:</p>
            <ul>
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <FeedbackBanner feedback={feedback} />
        {created ? (
          <p className="banner banner-success" role="status">
            Job submitted. <Link to={`/jobs/${created.id}`}>View job {created.id.slice(0, 8)}</Link>
          </p>
        ) : null}

        <button type="submit" className="primary" disabled={busy || !canOperate}>
          {busy ? "Submitting…" : "Submit job"}
        </button>
      </form>
    </>
  );
}
