import pg from "pg";
import { logWarn } from "@workmesh/shared";

export type Db = pg.Pool;

/** How long a request may wait to obtain a database connection before failing. */
export const CONNECT_TIMEOUT_MS = 2000;

/**
 * `max` is per process: N API instances hold up to N x max connections to PostgreSQL.
 *
 * Error events MUST be handled. In Node an `error` event with no listener throws and kills the
 * process. PostgreSQL sends such an event on a connection when it restarts, is stopped, or an
 * administrator terminates a backend, so without a listener a database restart used to take every
 * API instance down with it (found by the Phase 9 database-outage test: both containers exited
 * with code 1 and never came back). The pool drops the broken connection by itself and opens a new
 * one on the next query, so logging the event is all that is needed for the process to recover.
 */
export function createPool(connectionString: string, max = 10): Db {
  // connectionTimeoutMillis: without it a request waits as long as the operating system lets a
  // connection attempt hang (measured in Phase 9: 5-10 s per request, one client stuck for the
  // whole outage). 2 s makes the request fail fast with a clear 503 instead.
  const pool = new pg.Pool({ connectionString, max, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  // A connection that is idle in the pool.
  pool.on("error", (err) => logWarn("db_idle_connection_error", { error: err.message }));
  // A connection that is checked out (for example between statements of a transaction): its
  // errors are emitted on the client itself, where the pool's listener is not attached.
  pool.on("connect", (client) => {
    client.on("error", (err) => logWarn("db_connection_error", { error: err.message }));
  });
  return pool;
}
