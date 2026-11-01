/** Presentation helpers. Times are stored and transmitted in UTC; only the display is local. */

export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** 0.42 -> "420 ms", 3.14 -> "3.1 s", 125 -> "2m 5s", 7260 -> "2h 1m". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "–";
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  if (seconds < 10) return `${seconds.toFixed(1)} s`;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (seconds < 3600) return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes - hours * 60}m`;
}

/** "just now", "42s ago", "5m ago", "3h ago", "2d ago". */
export function formatAgo(from: Date, now: Date = new Date()): string {
  const seconds = Math.round((now.getTime() - from.getTime()) / 1000);
  if (seconds < -1) return `in ${formatDuration(-seconds)}`;
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/** Local date and time, or a dash for a missing value. */
export function formatDateTime(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return "–";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "–";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

export function formatClock(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "–";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

/** 1234 -> "1,234". Not abbreviated: operators compare exact counts. */
export function formatCount(n: number): string {
  return new Intl.NumberFormat().format(n);
}

/** Jobs per minute with sensible precision: 0 -> "0", 0.0667 -> "0.07", 12.5 -> "12.5". */
export function formatRate(perMinute: number): string {
  if (perMinute === 0) return "0";
  if (perMinute < 1) return perMinute.toFixed(2);
  if (perMinute < 100) return perMinute.toFixed(1);
  return Math.round(perMinute).toString();
}

/** Rounds a chart maximum UP to a tidy tick value (1, 2, 5 times a power of ten). */
export function niceMax(value: number): number {
  if (value <= 5) return Math.max(1, Math.ceil(value));
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) {
    if (value <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
}
