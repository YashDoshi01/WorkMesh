import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../api/client";
import { formatAgo, formatDateTime, shortId } from "../lib/format";

// Every status is shown as icon + word + colour. Colour alone is never the only signal.
const BADGES: Record<string, { icon: string; className: string }> = {
  queued: { icon: "◔", className: "neutral" },
  running: { icon: "▶", className: "info" },
  succeeded: { icon: "✓", className: "good" },
  failed: { icon: "✕", className: "critical" },
  cancelled: { icon: "⊘", className: "muted" },
  waiting: { icon: "…", className: "neutral" },
  skipped: { icon: "↷", className: "muted" },
  alive: { icon: "●", className: "good" },
  stale: { icon: "▲", className: "warning" },
  lease_expired: { icon: "⏱", className: "warning" },
  enabled: { icon: "✓", className: "good" },
  disabled: { icon: "⏸", className: "muted" },
  admin: { icon: "★", className: "info" },
  operator: { icon: "★", className: "info" },
  viewer: { icon: "◉", className: "neutral" },
  client: { icon: "↗", className: "info" },
  worker: { icon: "⚙", className: "neutral" },
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const badge = BADGES[status] ?? { icon: "•", className: "neutral" };
  return (
    <span className={`badge badge-${badge.className}`}>
      <span aria-hidden="true">{badge.icon}</span> {label ?? status.replace("_", " ")}
    </span>
  );
}

/** A timestamp. Stored and sent as UTC; shown in the viewer's local time with the UTC value on hover. */
export function Time({
  iso,
  relative = false,
}: {
  iso: string | null | undefined;
  relative?: boolean;
}) {
  if (!iso) return <span className="muted">–</span>;
  const date = new Date(iso);
  return (
    <time dateTime={iso} title={`${iso} (UTC)`}>
      {relative ? formatAgo(date) : formatDateTime(iso)}
    </time>
  );
}

export function JobLink({ id }: { id: string }) {
  return (
    <Link to={`/jobs/${id}`} className="mono" title={id}>
      {shortId(id)}
    </Link>
  );
}

/** Shows the outcome of an action: success, or the server's own explanation of a refusal. */
export type Feedback = { kind: "success" | "error"; message: string; details?: string[] } | null;

export function feedbackFromError(err: unknown): Feedback {
  if (err instanceof ApiError) {
    return {
      kind: "error",
      message: err.message,
      details: err.details.map((d) => `${d.path || "request"}: ${d.message}`),
    };
  }
  return { kind: "error", message: "Something went wrong." };
}

export function FeedbackBanner({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  return (
    <div
      className={`banner ${feedback.kind === "success" ? "banner-success" : "banner-error"}`}
      role={feedback.kind === "error" ? "alert" : "status"}
    >
      <p>{feedback.message}</p>
      {feedback.details && feedback.details.length > 0 ? (
        <ul>
          {feedback.details.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * A destructive action needs a second, deliberate click. The first click only arms it.
 * (This is a courtesy against slips. The server still refuses actions that are not allowed.)
 */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  disabled = false,
  danger = false,
  children,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
  disabled?: boolean;
  danger?: boolean;
  children?: ReactNode;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!armed) {
    return (
      <button type="button" disabled={disabled || busy} onClick={() => setArmed(true)}>
        {label}
        {children}
      </button>
    );
  }
  return (
    <span className="confirm" role="group" aria-label={`Confirm: ${label}`}>
      <button
        type="button"
        className={danger ? "danger" : "primary"}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onConfirm();
          } finally {
            setBusy(false);
            setArmed(false);
          }
        }}
      >
        {busy ? "Working…" : confirmLabel}
      </button>
      <button type="button" className="link-button" disabled={busy} onClick={() => setArmed(false)}>
        Keep
      </button>
    </span>
  );
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="page-header">
      <h1>{title}</h1>
      {children ? <div className="page-actions">{children}</div> : null}
    </div>
  );
}
