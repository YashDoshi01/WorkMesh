import { useId } from "react";

/**
 * A tiny trend line under a figure. Decorative: the number beside it is the information, so the
 * drawing is hidden from assistive technology. Draws nothing when there is nothing to draw.
 */
export function Sparkline({ values, bad = false }: { values: number[]; bad?: boolean }) {
  const id = useId();
  if (values.length < 2 || values.every((v) => v === 0)) return null;
  const W = 120;
  const H = 38;
  const PAD = 3;
  const max = Math.max(...values, 1);
  const step = (W - PAD * 2) / (values.length - 1);
  const pts = values.map((v, i) => [PAD + i * step, H - PAD - (v / max) * (H - PAD * 2)] as const);
  const line = pts
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join("");
  const last = pts[pts.length - 1]!;
  const area = `${line}L${last[0].toFixed(1)},${H}L${PAD},${H}Z`;
  const colour = bad ? "var(--critical)" : "var(--series-1)";
  return (
    <svg
      className={bad ? "sparkline is-bad" : "sparkline"}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={colour} stopOpacity="0.35" />
          <stop offset="100%" stopColor={colour} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path className="line" d={line} />
    </svg>
  );
}
