import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError, query } from "./client";

const json = (status: number, body: unknown): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function makeClient(
  fetchImpl: typeof fetch,
  options: { key?: string | null; onUnauthorized?: () => void } = {},
) {
  const key = options.key === undefined ? "secret-key" : options.key;
  return new ApiClient({
    getKey: () => key,
    ...(options.onUnauthorized ? { onUnauthorized: options.onUnauthorized } : {}),
    fetchImpl,
  });
}

const emptyStats = {
  generatedAt: "2026-01-01T00:00:00Z",
  windowMinutes: 60,
  bucketMinutes: 1,
  queue: { queued: 0, ready: 0, scheduled: 0, running: 0, oldestReadyAgeSeconds: null },
  window: {
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    retries: 0,
    leaseExpirations: 0,
    throughputPerMinute: 0,
    executionSeconds: null,
    waitSeconds: null,
  },
  series: [],
  workers: { alive: 0, stale: 0 },
};

describe("ApiClient", () => {
  it("sends the key as a Bearer token to the operator plane", async () => {
    const fetchImpl = vi.fn(async () => json(200, emptyStats));
    await makeClient(fetchImpl as unknown as typeof fetch).stats(60);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/ops/stats?windowMinutes=60");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret-key");
  });

  it("sends no Authorization header when signed out", async () => {
    const fetchImpl = vi.fn(async () => json(200, emptyStats));
    await makeClient(fetchImpl as unknown as typeof fetch, { key: null }).stats(60);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("me() can check a key without storing it", async () => {
    const fetchImpl = vi.fn(async () => json(200, { role: "viewer", actor: "viewer:12345678" }));
    const me = await makeClient(fetchImpl as unknown as typeof fetch, { key: null }).me(
      "candidate-key",
    );
    expect(me.role).toBe("viewer");
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer candidate-key");
  });

  it("maps the server's error body onto ApiError, including field details", async () => {
    const body = {
      error: {
        code: "validation_error",
        message: "Invalid job",
        details: [{ path: "type", message: "bad type" }],
      },
    };
    const client = makeClient((async () => json(400, body)) as unknown as typeof fetch);
    const err = await client.submitJob({ type: "X", payload: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const e = err as ApiError;
    expect([e.status, e.code, e.message]).toEqual([400, "validation_error", "Invalid job"]);
    expect(e.details).toEqual([{ path: "type", message: "bad type" }]);
  });

  it("tells the app to sign out on a 401", async () => {
    const onUnauthorized = vi.fn();
    const client = makeClient(
      (async () =>
        json(401, {
          error: { code: "unauthenticated", message: "Invalid API key" },
        })) as unknown as typeof fetch,
      { onUnauthorized },
    );
    await expect(client.stats(60)).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("does NOT sign out on a 403 (the key is fine, the role is not enough)", async () => {
    const onUnauthorized = vi.fn();
    const client = makeClient(
      (async () =>
        json(403, {
          error: { code: "forbidden", message: "needs operator" },
        })) as unknown as typeof fetch,
      { onUnauthorized },
    );
    await expect(client.cancelJob("x")).rejects.toMatchObject({ status: 403 });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("turns a network failure into a clear ApiError", async () => {
    const client = makeClient((async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch);
    const err = (await client.stats(60).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect([err.status, err.code]).toEqual([0, "network"]);
    expect(err.message).toMatch(/Cannot reach the API/);
  });

  it("rejects a response of the wrong shape instead of passing it on", async () => {
    const client = makeClient((async () =>
      json(200, { unexpected: true })) as unknown as typeof fetch);
    const err = (await client.stats(60).catch((e: unknown) => e)) as ApiError;
    expect([err.status, err.code]).toEqual([0, "bad_response"]);
  });

  it("copes with an error body that is not JSON (e.g. a proxy's HTML page)", async () => {
    const client = makeClient(
      (async () =>
        new Response("<html>Bad gateway</html>", { status: 502 })) as unknown as typeof fetch,
    );
    const err = (await client.stats(60).catch((e: unknown) => e)) as ApiError;
    expect([err.status, err.code]).toEqual([502, "unknown"]);
    expect(err.message).toMatch(/502/);
  });

  it("rethrows an abort the CALLER asked for, instead of calling it a network error", async () => {
    const controller = new AbortController();
    const client = makeClient(
      ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        })) as unknown as typeof fetch,
    );
    const pending = client.stats(60, controller.signal);
    controller.abort();
    const err = await pending.catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ApiError);
    expect((err as Error).name).toBe("AbortError");
  });

  it("sends JSON bodies with a content type", async () => {
    const fetchImpl = vi.fn(async () => json(200, { role: "x" }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.retryJob("abc", 3).catch(() => undefined);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/ops/jobs/abc/retry");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ attempts: 3 }));
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("encodes ids placed in a path", async () => {
    const fetchImpl = vi.fn(async () => json(404, { error: { code: "x", message: "m" } }));
    await makeClient(fetchImpl as unknown as typeof fetch)
      .job("a/b?c")
      .catch(() => undefined);
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("/ops/jobs/a%2Fb%3Fc");
  });

  it("accepts an empty 204 for deletes", async () => {
    const client = makeClient(
      (async () => new Response(null, { status: 204 })) as unknown as typeof fetch,
    );
    await expect(client.deleteSchedule("s1")).resolves.toBeUndefined();
  });
});

describe("query()", () => {
  it("omits empty, null and undefined values", () => {
    expect(query({ a: "1", b: "", c: undefined, d: null, e: 0 })).toBe("?a=1&e=0");
    expect(query({})).toBe("");
  });

  it("encodes special characters", () => {
    expect(query({ type: "a b&c" })).toBe("?type=a+b%26c");
  });
});

describe("job list requests", () => {
  it("asks for a page of 25 by default and forwards only the filters that are set", async () => {
    const fetchImpl = vi.fn(async () => json(200, { items: [], nextCursor: null }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.jobs({ status: "", type: "email.send", cursor: "abc" });
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe(
      "/ops/jobs?limit=25&type=email.send&cursor=abc",
    );
  });
});
