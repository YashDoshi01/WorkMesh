import type pg from "pg";
import type { Db } from "./pool.js";

export type Tx = pg.PoolClient;

/**
 * Runs `fn` inside one transaction on one connection: everything commits together or, if `fn`
 * throws, nothing does. The connection is always returned to the pool.
 */
export async function withTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    const result = await fn(tx);
    await tx.query("COMMIT");
    return result;
  } catch (err) {
    await tx.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    tx.release();
  }
}

/** Anything that can run a query: the pool, or a connection inside a transaction. */
export type Queryable = Pick<Db, "query"> | Tx;
