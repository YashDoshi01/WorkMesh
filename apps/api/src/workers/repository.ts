import type { Db } from "../db/pool.js";
import type { RegisterWorkerInput } from "./schema.js";

export interface Worker {
  id: string;
  name: string;
  jobTypes: string[];
  concurrency: number;
  registeredAt: string;
  lastHeartbeatAt: string;
}

interface WorkerRow {
  id: string;
  name: string;
  job_types: string[];
  concurrency: number;
  registered_at: Date;
  last_heartbeat_at: Date;
}

function toWorker(row: WorkerRow): Worker {
  return {
    id: row.id,
    name: row.name,
    jobTypes: row.job_types,
    concurrency: row.concurrency,
    registeredAt: row.registered_at.toISOString(),
    lastHeartbeatAt: row.last_heartbeat_at.toISOString(),
  };
}

export class WorkerRepository {
  constructor(private readonly db: Db) {}

  /** Each running worker process registers itself and gets a fresh identity. */
  async register(input: RegisterWorkerInput): Promise<Worker> {
    const result = await this.db.query<WorkerRow>(
      `INSERT INTO workers (name, job_types, concurrency)
       VALUES ($1, $2, $3)
       RETURNING id, name, job_types, concurrency, registered_at, last_heartbeat_at`,
      [input.name, input.jobTypes, input.concurrency],
    );
    return toWorker(result.rows[0]!);
  }

  /** Records "this worker is alive now". Returns null for an unknown worker id. */
  async heartbeat(id: string): Promise<Worker | null> {
    const result = await this.db.query<WorkerRow>(
      `UPDATE workers SET last_heartbeat_at = now() WHERE id = $1
       RETURNING id, name, job_types, concurrency, registered_at, last_heartbeat_at`,
      [id],
    );
    const row = result.rows[0];
    return row ? toWorker(row) : null;
  }
}
