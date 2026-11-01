import pg from "pg";

export type Db = pg.Pool;

/** `max` is per process: N API instances hold up to N x max connections to PostgreSQL. */
export function createPool(connectionString: string, max = 10): Db {
  return new pg.Pool({ connectionString, max });
}
