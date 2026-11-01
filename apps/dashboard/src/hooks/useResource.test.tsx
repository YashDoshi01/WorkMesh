import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { deferred } from "../test-utils";
import { useResource } from "./useResource";

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  vi.useRealTimers();
  setHidden(false);
});

describe("useResource: states", () => {
  it("starts loading, then has data", async () => {
    const { result } = renderHook(() => useResource("k", async () => 42));
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.data).toBe(42));
    expect(result.current.loading).toBe(false);
    expect(result.current.stale).toBe(false);
    expect(result.current.updatedAt).toBeInstanceOf(Date);
  });

  it("an initial failure is an error, not stale data", async () => {
    const boom = new ApiError(500, "internal_error", "Internal server error");
    const { result } = renderHook(() =>
      useResource("k", async () => {
        throw boom;
      }),
    );
    await waitFor(() => expect(result.current.error).toBe(boom));
    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(false);
    expect(result.current.stale).toBe(false);
  });

  it("a failed refresh KEEPS the old data and marks it stale; the next success clears it", async () => {
    let call = 0;
    const fetcher = vi.fn(async () => {
      call++;
      if (call === 2) throw new ApiError(0, "network", "offline");
      return `v${call}`;
    });
    const { result } = renderHook(() => useResource("k", fetcher));
    await waitFor(() => expect(result.current.data).toBe("v1"));

    act(() => result.current.reload());
    await waitFor(() => expect(result.current.stale).toBe(true));
    expect(result.current.data).toBe("v1");
    expect(result.current.error?.code).toBe("network");

    act(() => result.current.reload());
    await waitFor(() => expect(result.current.data).toBe("v3"));
    expect(result.current.stale).toBe(false);
    expect(result.current.error).toBeUndefined();
  });

  it("shows `refreshing` (not `loading`) while later fetches run", async () => {
    const second = deferred<string>();
    let call = 0;
    const { result } = renderHook(() =>
      useResource("k", () => (++call === 1 ? Promise.resolve("first") : second.promise)),
    );
    await waitFor(() => expect(result.current.data).toBe("first"));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.refreshing).toBe(true));
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBe("first");
    await act(async () => second.resolve("second"));
    await waitFor(() => expect(result.current.data).toBe("second"));
    expect(result.current.refreshing).toBe(false);
  });
});

describe("useResource: keys and races", () => {
  it("changing the key drops the old data immediately (no flash of the wrong list)", async () => {
    const { result, rerender } = renderHook(
      ({ k }) => useResource(k, async () => `data for ${k}`),
      {
        initialProps: { k: "a" },
      },
    );
    await waitFor(() => expect(result.current.data).toBe("data for a"));
    rerender({ k: "b" });
    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.data).toBe("data for b"));
  });

  it("a slow answer for an OLD key can never overwrite the new one", async () => {
    const slowA = deferred<string>();
    const { result, rerender } = renderHook(
      ({ k }) => useResource(k, () => (k === "a" ? slowA.promise : Promise.resolve("B"))),
      { initialProps: { k: "a" } },
    );
    rerender({ k: "b" });
    await waitFor(() => expect(result.current.data).toBe("B"));
    await act(async () => slowA.resolve("A (late)"));
    expect(result.current.data).toBe("B");
  });

  it("aborts the request in flight when the component goes away", async () => {
    let seen: AbortSignal | undefined;
    const { unmount } = renderHook(() =>
      useResource("k", (signal) => {
        seen = signal;
        return new Promise<string>(() => undefined);
      }),
    );
    await waitFor(() => expect(seen).toBeDefined());
    expect(seen!.aborted).toBe(false);
    unmount();
    expect(seen!.aborted).toBe(true);
  });
});

describe("useResource: polling", () => {
  it("refreshes on an interval", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => "x");
    renderHook(() => useResource("k", fetcher, { intervalMs: 1000 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("never starts a second request while one is still running", async () => {
    vi.useFakeTimers();
    const pending = deferred<string>();
    const fetcher = vi.fn(() => pending.promise);
    renderHook(() => useResource("k", fetcher, { intervalMs: 1000 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve("done"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not poll while the tab is hidden, and refreshes at once when it comes back", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => "x");
    renderHook(() => useResource("k", fetcher, { intervalMs: 1000 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    act(() => setHidden(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      setHidden(false);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("stops polling after unmount", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => "x");
    const { unmount } = renderHook(() => useResource("k", fetcher, { intervalMs: 1000 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
