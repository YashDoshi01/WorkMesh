import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { formatClock, formatCount, niceMax } from "../lib/format";

export interface Bucket {
  start: string;
  succeeded: number;
  failed: number;
}

// Geometry, in SVG user units. The viewBox scales to the container width.
const W = 720;
const H = 232;
const LEFT = 40;
const RIGHT = 8;
const TOP = 18; // room for the peak label above the tallest bar
const BOTTOM = 26; // the x-axis label band is INSIDE the height, so nothing scrolls or clips
const PLOT_W = W - LEFT - RIGHT;
const PLOT_H = H - TOP - BOTTOM;
const BASE_Y = TOP + PLOT_H;

const MAX_BAR = 24; // bars are never wider than this: the slot's leftover is air
const GAP = 2; // surface-coloured gap between stacked segments
const RADIUS = 4; // rounded data end; the baseline end stays square
const MIN_SEGMENT = 2; // a non-zero value is always visible

/** A bar with rounded top corners and a square bottom, as a path. */
function roundedTop(x: number, y: number, w: number, h: number): string {
  const r = Math.min(RADIUS, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/**
 * Jobs finished per time bucket: succeeded (bottom) and failed (top), stacked.
 *
 * Colour: succeeded = categorical blue, failed = the reserved "critical" red. They pass the
 * colour-blind and contrast checks as a pair (see docs/DASHBOARD.md); the legend adds an icon
 * and a word, so colour is never the only carrier.
 * Reading: hover or focus a column for exact numbers (arrow keys move between columns), or
 * switch to the table view, which holds every value.
 */
export function StackedColumns({
  buckets,
  bucketMinutes,
  dimmed = false,
}: {
  buckets: Bucket[];
  bucketMinutes: number;
  dimmed?: boolean;
}) {
  const [active, setActive] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const tooltipId = useId();
  const frameRef = useRef<HTMLDivElement>(null);

  // On a narrow screen the chart scrolls sideways. Start at the RIGHT edge: the newest data is the
  // part that matters. (Runs on mount and when switching back from the table, not on each refresh.)
  useEffect(() => {
    const frame = frameRef.current;
    if (frame) frame.scrollLeft = frame.scrollWidth;
  }, [asTable]);

  const totals = buckets.map((b) => b.succeeded + b.failed);
  const peak = Math.max(0, ...totals);
  const max = niceMax(peak);
  const ticks = max <= 5 ? Array.from({ length: max + 1 }, (_, i) => i) : [0, max / 2, max];
  const slot = PLOT_W / Math.max(1, buckets.length);
  const barW = Math.min(MAX_BAR, Math.max(2, slot - GAP));
  const centerX = (i: number): number => LEFT + i * slot + slot / 2;
  const y = (value: number): number => BASE_Y - (value / max) * PLOT_H;

  const peakIndex = totals.indexOf(peak);
  const bucketLabel = (i: number): string => {
    const b = buckets[i];
    if (!b) return "";
    const end = new Date(Date.parse(b.start) + bucketMinutes * 60_000).toISOString();
    return `${formatClock(b.start)}–${formatClock(end)}`;
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (buckets.length === 0) return;
    const last = buckets.length - 1;
    if (e.key === "ArrowRight") setActive((a) => (a === null ? last : Math.min(last, a + 1)));
    else if (e.key === "ArrowLeft") setActive((a) => (a === null ? last : Math.max(0, a - 1)));
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(last);
    else if (e.key === "Escape") setActive(null);
    else return;
    e.preventDefault();
  };

  const activeBucket = active === null ? undefined : buckets[active];
  const summary = `Jobs finished in each ${bucketMinutes}-minute period: ${formatCount(
    buckets.reduce((n, b) => n + b.succeeded, 0),
  )} succeeded, ${formatCount(buckets.reduce((n, b) => n + b.failed, 0))} failed.`;

  return (
    <figure className="chart" aria-label="Jobs finished over time">
      <div className="chart-toolbar">
        <ul className="legend" aria-label="Legend">
          <li>
            <span className="swatch swatch-succeeded" aria-hidden="true" /> ✓ Succeeded
          </li>
          <li>
            <span className="swatch swatch-failed" aria-hidden="true" /> ✕ Failed
          </li>
        </ul>
        <button type="button" className="link-button" onClick={() => setAsTable((v) => !v)}>
          {asTable ? "Show as chart" : "Show as table"}
        </button>
      </div>

      {asTable ? (
        <div className="table-wrap">
          <table>
            <caption className="visually-hidden">{summary}</caption>
            <thead>
              <tr>
                <th scope="col">Period</th>
                <th scope="col" className="num">
                  Succeeded
                </th>
                <th scope="col" className="num">
                  Failed
                </th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((b, i) => (
                <tr key={b.start}>
                  <th scope="row">{bucketLabel(i)}</th>
                  <td className="num">{formatCount(b.succeeded)}</td>
                  <td className="num">{formatCount(b.failed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div
          className={`chart-frame${dimmed ? " is-refreshing" : ""}${active !== null ? " has-active" : ""}`}
          ref={frameRef}
          tabIndex={0}
          role="group"
          aria-label={`${summary} Use the arrow keys to read each period.`}
          aria-describedby={tooltipId}
          onKeyDown={onKey}
          onBlur={() => setActive(null)}
          onMouseLeave={() => setActive(null)}
        >
          <div className="chart-canvas">
            <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" aria-hidden="true">
              {ticks.map((t) => (
                <g key={t}>
                  <line className="grid" x1={LEFT} x2={W - RIGHT} y1={y(t)} y2={y(t)} />
                  <text className="axis-label" x={LEFT - 6} y={y(t) + 4} textAnchor="end">
                    {formatCount(t)}
                  </text>
                </g>
              ))}
              <line className="baseline" x1={LEFT} x2={W - RIGHT} y1={BASE_Y} y2={BASE_Y} />

              {buckets.map((b, i) => {
                const x = centerX(i) - barW / 2;
                const hs =
                  b.succeeded > 0 ? Math.max(MIN_SEGMENT, (b.succeeded / max) * PLOT_H) : 0;
                const hf = b.failed > 0 ? Math.max(MIN_SEGMENT, (b.failed / max) * PLOT_H) : 0;
                const gap = hs > 0 && hf > 0 ? GAP : 0;
                return (
                  <g key={b.start} className={`column${active === i ? " active" : ""}`}>
                    {hs > 0 ? (
                      hf > 0 ? (
                        <rect
                          className="seg seg-succeeded"
                          x={x}
                          y={BASE_Y - hs}
                          width={barW}
                          height={hs}
                        />
                      ) : (
                        <path
                          className="seg seg-succeeded"
                          d={roundedTop(x, BASE_Y - hs, barW, hs)}
                        />
                      )
                    ) : null}
                    {hf > 0 ? (
                      <path
                        className="seg seg-failed"
                        d={roundedTop(x, BASE_Y - hs - hf, barW, hf - gap)}
                      />
                    ) : null}
                    {/* The hover and focus target is the whole slot, far bigger than the bar. */}
                    <rect
                      className="hit"
                      x={LEFT + i * slot}
                      y={TOP}
                      width={slot}
                      height={PLOT_H}
                      onMouseEnter={() => setActive(i)}
                      onMouseMove={() => setActive(i)}
                    />
                  </g>
                );
              })}

              {/* Selective direct label: only the peak, never a number on every bar. */}
              {peak > 0 ? (
                <text
                  className="peak-label"
                  x={Math.min(W - RIGHT - 16, Math.max(LEFT + 16, centerX(peakIndex)))}
                  y={Math.max(11, y(peak) - 5)}
                  textAnchor="middle"
                >
                  {formatCount(peak)}
                </text>
              ) : null}

              {[0, Math.floor((buckets.length - 1) / 2), buckets.length - 1].map((i, n) => {
                const b = buckets[i];
                if (!b || (n > 0 && i === 0)) return null;
                return (
                  <text
                    key={`${n}-${i}`}
                    className="axis-label"
                    x={centerX(i)}
                    y={H - 8}
                    textAnchor={n === 0 ? "start" : n === 2 ? "end" : "middle"}
                  >
                    {formatClock(b.start)}
                  </text>
                );
              })}
            </svg>

            <div
              id={tooltipId}
              className="tooltip"
              role="status"
              aria-live="polite"
              hidden={!activeBucket}
              style={
                active === null
                  ? undefined
                  : ({ "--x": `${(centerX(active) / W) * 100}%` } as CSSProperties)
              }
            >
              {activeBucket ? (
                <>
                  <p className="tooltip-title">{bucketLabel(active!)}</p>
                  <p>
                    <span className="key key-succeeded" aria-hidden="true" />
                    <strong>{formatCount(activeBucket.succeeded)}</strong> succeeded
                  </p>
                  <p>
                    <span className="key key-failed" aria-hidden="true" />
                    <strong>{formatCount(activeBucket.failed)}</strong> failed
                  </p>
                </>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </figure>
  );
}
