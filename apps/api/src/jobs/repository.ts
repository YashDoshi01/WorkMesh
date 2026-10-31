import type { Db } from "../db/pool.js";
import type { CreateJobInput, JobStatus } from "./schema.js";

export interface Job {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  priority: number;
  runAt: string;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
}

interface JobRow {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  priority: number;
  run_at: Date;
  attempt_count: number;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS =
  "id, type, payload, status, priority, run_at, attempt_count, created_at, updated_at";

// Postgres timestamps have microsecond precision; JS Dates only milliseconds.
// The pagination cursor must keep full precision or rows could be skipped/repeated.
const CURSOR_TS = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    type: row.type,
    payload: row.payload,
    status: row.status,
    priority: row.priority,
    runAt: row.run_at.toISOString(),
    attemptCount: row.attempt_count,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface JobPage {
  items: Job[];
  nextCursor: string | null;
}

export class InvalidCursorError extends Error {}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id])).toString("base64url");
}

function decodeCursor(cursor: string): [string, string] {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(parsed[0]) &&
      /^[0-9a-f-]{36}$/i.test(parsed[1])
    ) {
      return [parsed[0], parsed[1]];
    }
  } catch {
    // fall through
  }
  throw new InvalidCursorError("cursor is not valid");
}

export class JobRepository {
  constructor(private readonly db: Db) {}

  /** A single INSERT is atomic on its own; the row is committed before this resolves. */
  async create(input: CreateJobInput): Promise<Job> {
    const result = await this.db.query<JobRow>(
      `INSERT INTO jobs (type, payload, priority, run_at)
       VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()))
       RETURNING ${COLUMNS}`,
      [input.type, JSON.stringify(input.payload), input.priority, input.runAt ?? null],
    );
    return toJob(result.rows[0]!);
  }

  async findById(id: string): Promise<Job | null> {
    const result = await this.db.query<JobRow>(`SELECT ${COLUMNS} FROM jobs WHERE id = $1`, [id]);
    const row = result.rows[0];
    return row ? toJob(row) : null;
  }

  /** Newest first, keyset-paginated on (created_at, id). */
  async list(filter: {
    status?: JobStatus | undefined;
    type?: string | undefined;
    limit: number;
    cursor?: string | undefined;
  }): Promise<JobPage> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }
    if (filter.type) {
      params.push(filter.type);
      where.push(`type = $${params.length}`);
    }
    if (filter.cursor) {
      const [ts, id] = decodeCursor(filter.cursor);
      params.push(ts, id);
      where.push(
        `(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }
    params.push(filter.limit + 1);
    const result = await this.db.query<JobRow & { cursor_ts: string }>(
      `SELECT ${COLUMNS}, ${CURSOR_TS} AS cursor_ts FROM jobs
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at DESC, id DESC
       LIMIT $${params.length}`,
      params,
    );
    const hasMore = result.rows.length > filter.limit;
    const rows = hasMore ? result.rows.slice(0, filter.limit) : result.rows;
    const last = rows[rows.length - 1];
    return {
      items: rows.map(toJob),
      nextCursor: hasMore && last ? encodeCursor(last.cursor_ts, last.id) : null,
    };
  }
}
