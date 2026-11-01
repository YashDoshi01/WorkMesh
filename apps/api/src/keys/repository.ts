import type { Db } from "../db/pool.js";
import type { Queryable } from "../db/tx.js";
import { digestsEqual, generateKey, sha256, type ParsedKey } from "./keys.js";

export type KeyKind = "client" | "worker";

/** A key as shown to operators. Never contains the secret or its digest. */
export interface ApiKey {
  id: string;
  prefix: string;
  kind: KeyKind;
  account: string;
  name: string;
  jobTypes: string[] | null;
  createdAt: string;
  createdBy: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  lastUsedAt: string | null;
  /** active | revoked | expired, derived from the timestamps. */
  status: "active" | "revoked" | "expired";
}

interface Row {
  id: string;
  prefix: string;
  kind: KeyKind;
  account: string;
  name: string;
  job_types: string[] | null;
  created_at: Date;
  created_by: string;
  expires_at: Date | null;
  revoked_at: Date | null;
  revoked_by: string | null;
  last_used_at: Date | null;
  expired: boolean;
}

const COLUMNS = `id, prefix, kind, account, name, job_types, created_at, created_by, expires_at,
  revoked_at, revoked_by, last_used_at, (expires_at IS NOT NULL AND expires_at <= now()) AS expired`;

function toKey(r: Row): ApiKey {
  return {
    id: r.id,
    prefix: r.prefix,
    kind: r.kind,
    account: r.account,
    name: r.name,
    jobTypes: r.job_types,
    createdAt: r.created_at.toISOString(),
    createdBy: r.created_by,
    expiresAt: r.expires_at?.toISOString() ?? null,
    revokedAt: r.revoked_at?.toISOString() ?? null,
    revokedBy: r.revoked_by,
    lastUsedAt: r.last_used_at?.toISOString() ?? null,
    status: r.revoked_at ? "revoked" : r.expired ? "expired" : "active",
  };
}

export type AuthFailure = "unknown_key" | "bad_secret" | "revoked" | "expired";
export type AuthResult =
  { ok: true; key: ApiKey } | { ok: false; reason: AuthFailure; prefix: string };

// Compared against when the prefix is unknown, so "no such key" and "wrong secret" take the same
// comparison work.
const DUMMY_DIGEST = sha256("workmesh-unknown-key");

const TOUCH_EVERY = "60 seconds";

export class ApiKeyRepository {
  constructor(private readonly db: Db) {}

  /**
   * Creates a key and returns it together with its secret. The secret exists only in this return
   * value. Pass the transaction so the audit record commits with the key.
   */
  async create(
    q: Queryable,
    input: {
      kind: KeyKind;
      account: string;
      name: string;
      jobTypes: string[] | null;
      expiresInDays: number | null;
      createdBy: string;
    },
  ): Promise<{ key: ApiKey; secret: string }> {
    // A prefix collision (32 bits) is astronomically unlikely but possible: retry with a new one.
    for (let attempt = 0; attempt < 5; attempt++) {
      const generated = generateKey();
      await q.query("SAVEPOINT key_insert");
      try {
        const r = await q.query<Row>(
          `INSERT INTO api_keys
             (prefix, secret_hash, kind, account, name, job_types, expires_at, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, now() + ($7::int * interval '1 day'), $8)
           RETURNING ${COLUMNS}`,
          [
            generated.prefix,
            generated.digest,
            input.kind,
            input.account,
            input.name,
            input.jobTypes,
            input.expiresInDays,
            input.createdBy,
          ],
        );
        await q.query("RELEASE SAVEPOINT key_insert");
        return { key: toKey(r.rows[0]!), secret: generated.secret };
      } catch (err) {
        await q.query("ROLLBACK TO SAVEPOINT key_insert");
        if ((err as { code?: string }).code !== "23505") throw err;
      }
    }
    throw new Error("could not generate a unique key prefix");
  }

  async list(): Promise<ApiKey[]> {
    const r = await this.db.query<Row>(
      `SELECT ${COLUMNS} FROM api_keys ORDER BY created_at DESC, id DESC LIMIT 500`,
    );
    return r.rows.map(toKey);
  }

  async findById(id: string, q: Queryable = this.db): Promise<ApiKey | null> {
    const r = await q.query<Row>(`SELECT ${COLUMNS} FROM api_keys WHERE id = $1`, [id]);
    return r.rows[0] ? toKey(r.rows[0]) : null;
  }

  /**
   * Revokes a key. Immediate and visible to every API instance at once, because every request
   * checks the database (no per-process cache). Repeating it changes nothing and keeps the
   * original who/when.
   */
  async revoke(q: Queryable, id: string, by: string): Promise<ApiKey | null> {
    await q.query(
      `UPDATE api_keys SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND revoked_at IS NULL`,
      [id, by],
    );
    return this.findById(id, q);
  }

  /** Checks a presented key. Every failure path does one lookup and one constant-time compare. */
  async authenticate(parsed: ParsedKey): Promise<AuthResult> {
    const r = await this.db.query<Row & { secret_hash: Buffer; touch_due: boolean }>(
      `SELECT ${COLUMNS}, secret_hash,
              (last_used_at IS NULL OR last_used_at < now() - interval '${TOUCH_EVERY}') AS touch_due
       FROM api_keys WHERE prefix = $1`,
      [parsed.prefix],
    );
    const row = r.rows[0];
    const matches = digestsEqual(parsed.digest, row ? row.secret_hash : DUMMY_DIGEST);
    if (!row) return { ok: false, reason: "unknown_key", prefix: parsed.prefix };
    if (!matches) return { ok: false, reason: "bad_secret", prefix: parsed.prefix };
    const key = toKey(row);
    if (key.status === "revoked") return { ok: false, reason: "revoked", prefix: parsed.prefix };
    if (key.status === "expired") return { ok: false, reason: "expired", prefix: parsed.prefix };
    // Record "last used" at most once a minute per key. Whether it is due is decided by the SELECT
    // above, so the common case costs no extra statement. (Phase 9, five runs each: submissions
    // 1,422 -> 1,596 per second, completions 837 -> 913 per second, about +9-12%, p about 0.03.)
    if (row.touch_due) {
      await this.db.query(
        `UPDATE api_keys SET last_used_at = now()
         WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '${TOUCH_EVERY}')`,
        [key.id],
      );
    }
    return { ok: true, key };
  }
}
