import type { Progress } from "../api/schemas";
import { formatCount } from "../lib/format";

// Order is deliberate: finished work first, then live work, then waiting, then dead ends.
const PARTS = [
  { key: "succeeded", icon: "✓", label: "succeeded" },
  { key: "running", icon: "▶", label: "running" },
  { key: "queued", icon: "◔", label: "queued" },
  { key: "waiting", icon: "…", label: "waiting" },
  { key: "skipped", icon: "↷", label: "skipped" },
  { key: "cancelled", icon: "⊘", label: "cancelled" },
  { key: "failed", icon: "✕", label: "failed" },
] as const;

/**
 * A thin segmented bar: one whole (the workflow's nodes) split into parts. Widths are
 * proportional; a part at zero draws nothing. The counts are printed beside it, so the bar
 * is never the only way to read a value.
 */
export function ProgressBar({ progress }: { progress: Progress }) {
  const present = PARTS.filter((p) => progress[p.key] > 0);
  const summary = present.map((p) => `${progress[p.key]} ${p.label}`).join(", ");
  return (
    <div className="progress">
      <div
        className="progress-bar"
        role="img"
        aria-label={`${progress.total} nodes: ${summary || "none"}`}
      >
        {present.map((p) => (
          <span
            key={p.key}
            className={`progress-part part-${p.key}`}
            style={{ flexGrow: progress[p.key] }}
            title={`${progress[p.key]} ${p.label}`}
          />
        ))}
      </div>
      <ul className="progress-counts">
        {present.map((p) => (
          <li key={p.key}>
            <span aria-hidden="true">{p.icon}</span> {formatCount(progress[p.key])} {p.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
