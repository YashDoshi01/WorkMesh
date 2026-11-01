import type { Db } from "../db/pool.js";
import type { RegisterWorkerInput } from "./schema.js";

export interface Worker {
  id: string;
  name: string;
  jobTypes: string[];
  concurrency: number;
  account: string;
  registeredAt: string;
  lastHeartbeatAt: string;
}

interface WorkerRow {
  id: string;
  name: string;
  job_types: string[];
  concurrency: number;
  account: string;
  registered_at: Date;
  last_heartbeat_at: Date;
}

function toWorker(row: WorkerRow): Worker {
  return {
    id: row.id,
    name: row.name,
    jobTypes: row.job_types,
    concurrency: row.concurrency,
    account: row.account,
    registeredAt: row.registered_at.toISOString(),
    lastHeartbeatAt: row.last_heartbeat_at.toISOString(),
  };
}

const W_COLUMNS = "id, name, job_types, concurrency, account, registered_at, last_heartbeat_at";

export class WorkerRepository {
  constructor(private readonly db: Db) {}

  /** Each running worker process registers itself and gets a fresh identity. */
  async register(
    input: RegisterWorkerInput,
    owner: { account: string; apiKeyId: string | null } = { account: "default", apiKeyId: null },
  ): Promise<Worker> {
    const result = await this.db.query<WorkerRow>(
      `INSERT INTO workers (name, job_types, concurrency, account, api_key_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${W_COLUMNS}`,
      [input.name, input.jobTypes, input.concurrency, owner.account, owner.apiKeyId],
    );
    return toWorker(result.rows[0]!);
  }

  /** Whether this worker id was registered by the given API key. */
  async isOwnedBy(id: string, apiKeyId: string): Promise<boolean> {
    const r = await this.db.query("SELECT 1 FROM workers WHERE id = $1 AND api_key_id = $2", [
      id,
      apiKeyId,
    ]);
    return (r.rowCount ?? 0) > 0;
  }

  /** Records "this worker is alive now". Returns null for an unknown worker id. */
  async heartbeat(id: string, apiKeyId: string | null = null): Promise<Worker | null> {
    // A worker id alone is not enough: it must have been registered by the SAME key that is
    // calling now (apiKeyId null = authentication off, tests only).
    const result = await this.db.query<WorkerRow>(
      `UPDATE workers SET last_heartbeat_at = now()
       WHERE id = $1 AND ($2::uuid IS NULL OR api_key_id = $2)
       RETURNING ${W_COLUMNS}`,
      [id, apiKeyId],
    );
    const row = result.rows[0];
    return row ? toWorker(row) : null;
  }
}
