import type { ReactNode } from "react";
import type { Resource } from "../hooks/useResource";
import { formatClock } from "../lib/format";

interface Props<T> {
  resource: Resource<T>;
  /** Render the data. Only called when there is data and it is not empty. */
  children: (data: T) => ReactNode;
  /** True when the data is "valid but has nothing in it" (an empty list). */
  isEmpty?: (data: T) => boolean;
  /** What to say when it is empty. */
  empty?: ReactNode;
  /** Used in messages, e.g. "jobs". */
  what?: string;
}

/**
 * The four states every screen has, handled in one place so no page forgets one:
 *
 *   loading : nothing to show yet
 *   error   : the load failed and there is nothing older to show
 *   empty   : loaded fine, nothing in it
 *   stale   : showing older data because the latest refresh failed (says so, and when it is from)
 *
 * While a refresh is running the previous content stays on screen, slightly dimmed, so the
 * layout never jumps.
 */
export function DataView<T>({ resource, children, isEmpty, empty, what = "data" }: Props<T>) {
  const { data, error, loading, refreshing, stale, updatedAt, reload } = resource;

  if (loading) {
    return (
      <p className="state state-loading" role="status">
        Loading {what}…
      </p>
    );
  }

  if (data === undefined) {
    return (
      <div className="state state-error" role="alert">
        <p>
          <strong>Could not load {what}.</strong> {error?.message}
        </p>
        <button type="button" onClick={reload}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className={refreshing ? "data is-refreshing" : "data"} aria-busy={refreshing}>
      {stale && error ? (
        <p className="banner banner-warning" role="status">
          Could not refresh {what} ({error.message}). Showing what was loaded
          {updatedAt ? ` at ${formatClock(updatedAt.toISOString())}` : ""}.{" "}
          <button type="button" className="link-button" onClick={reload}>
            Try again
          </button>
        </p>
      ) : null}
      {isEmpty?.(data) ? (
        <p className="state state-empty">{empty ?? `No ${what}.`}</p>
      ) : (
        children(data)
      )}
    </div>
  );
}
