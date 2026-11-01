import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";

export interface Resource<T> {
  /** The latest successfully loaded data. Kept while a refresh is running or has failed. */
  data: T | undefined;
  /** The most recent failure. If `data` is also set, the screen is showing STALE data. */
  error: ApiError | undefined;
  /** First load for this key: nothing to show yet. */
  loading: boolean;
  /** A later refresh is in flight (the previous data stays on screen). */
  refreshing: boolean;
  /** Data is shown, but the latest refresh failed. */
  stale: boolean;
  /** When `data` was fetched. */
  updatedAt: Date | undefined;
  reload: () => void;
}

interface State<T> {
  /** Which key this state belongs to. State for any other key is ignored (treated as empty). */
  forKey: string;
  data: T | undefined;
  error: ApiError | undefined;
  updatedAt: Date | undefined;
  inFlight: boolean;
}

function toApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError(0, "unknown", "Something went wrong.");
}

/**
 * Loads data and keeps it fresh.
 *
 *  - `key` identifies WHAT is loaded (the URL, the filters). State from a different key is
 *    never shown, so changing a filter starts from "loading" without any reset step; while the
 *    key is unchanged, refreshes keep the old data on screen (no flash of an empty state).
 *  - With `intervalMs`, refreshes repeat, but never overlap, and pause while the tab is hidden.
 *  - A response for an outdated key or request is ignored, so a slow answer can never overwrite
 *    a newer one.
 *  - If a refresh fails after data was loaded, the data stays and `stale` is true.
 */
export function useResource<T>(
  key: string,
  fetcher: (signal: AbortSignal) => Promise<T>,
  options: { intervalMs?: number | undefined } = {},
): Resource<T> {
  const { intervalMs } = options;
  const [state, setState] = useState<State<T>>({
    forKey: key,
    data: undefined,
    error: undefined,
    updatedAt: undefined,
    inFlight: true,
  });
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });
  const runRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let generation = 0;

    const schedule = (): void => {
      if (intervalMs === undefined || cancelled) return;
      timer = setTimeout(() => run(false), intervalMs);
    };

    function run(initial: boolean): void {
      if (cancelled || inFlight) return;
      if (document.hidden) {
        schedule(); // check again later; do not call the API for a tab nobody is looking at
        return;
      }
      inFlight = true;
      const mine = ++generation;
      controller = new AbortController();
      // The first load needs no "in flight" marker: having no data yet already means "loading".
      if (!initial) setState((s) => (s.forKey === key ? { ...s, inFlight: true } : s));
      fetcherRef
        .current(controller.signal)
        .then((data) => {
          if (cancelled || mine !== generation) return;
          setState({ forKey: key, data, error: undefined, updatedAt: new Date(), inFlight: false });
        })
        .catch((err: unknown) => {
          if (cancelled || mine !== generation) return;
          setState((s) =>
            s.forKey === key
              ? { ...s, error: toApiError(err), inFlight: false }
              : {
                  forKey: key,
                  data: undefined,
                  error: toApiError(err),
                  updatedAt: undefined,
                  inFlight: false,
                },
          );
        })
        .finally(() => {
          inFlight = false;
          schedule();
        });
    }

    runRef.current = () => {
      clearTimeout(timer);
      run(false);
    };

    const onVisible = (): void => {
      if (!document.hidden) runRef.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    run(true);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [key, intervalMs]);

  const reload = useCallback(() => runRef.current(), []);
  const current = state.forKey === key ? state : undefined;
  const data = current?.data;
  const error = current?.error;
  const hasData = data !== undefined;
  return {
    data,
    error,
    loading: !hasData && error === undefined,
    refreshing: hasData && (current?.inFlight ?? false),
    stale: hasData && error !== undefined,
    updatedAt: current?.updatedAt,
    reload,
  };
}
