import type { Server } from "node:http";

export interface ShutdownOptions {
  server: Server;
  /** Shared with the app: while `draining` is true /readyz says "not ready" and connections are not reused. */
  drain: { draining: boolean };
  /** Keep serving, but report "not ready", for this long first. */
  drainMs: number;
  /** After the drain, how long in-flight requests get before their connections are cut. */
  graceMs: number;
  /** Runs once the server has stopped: stop background work, close pools. */
  cleanup: () => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Stops an API instance without dropping requests it has already accepted.
 *
 *  1. DRAIN: flip `draining`. /readyz now answers 503 and responses carry `Connection: close`,
 *     but the instance still serves everything. This gives an orchestrator (or an active health
 *     check) time to stop sending traffic. NGINX open source only notices failed requests, not
 *     /readyz, so for it the drain is a pause, not a signal (see docs/GATEWAY.md).
 *  2. CLOSE: stop accepting new connections. New connection attempts now fail immediately
 *     ("connection refused"), which a gateway treats as "try the other instance", before it
 *     has sent anything, so even a POST can be retried safely.
 *  3. FINISH: wait for in-flight requests. Idle keep-alive connections are closed repeatedly,
 *     because a connection becomes idle only when its last response ends. After `graceMs` any
 *     connection still open is cut, so shutdown can never hang forever.
 *  4. CLEANUP: stop the background loops, close the database pool.
 *
 * Resolves with whether step 3 had to cut connections.
 */
export async function gracefulShutdown(options: ShutdownOptions): Promise<{ forced: boolean }> {
  const { server, drain, drainMs, graceMs, cleanup } = options;
  drain.draining = true;
  await sleep(drainMs);

  const forced = await new Promise<boolean>((resolve) => {
    let cut = false;
    const sweep = setInterval(() => server.closeIdleConnections(), 200);
    const deadline = setTimeout(() => {
      cut = true;
      server.closeAllConnections();
    }, graceMs);
    server.close(() => {
      clearInterval(sweep);
      clearTimeout(deadline);
      resolve(cut);
    });
    server.closeIdleConnections();
  });

  await cleanup();
  return { forced };
}
