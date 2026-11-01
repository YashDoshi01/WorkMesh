import type { Db } from "../db/pool.js";
import type { Queryable } from "../db/tx.js";
import type { Role } from "./auth.js";

/** Who did it. Operators are viewer/operator; customer users are admin/viewer. */
export type AuditRole = Role | "admin";
export interface AuditActor {
  role: AuditRole;
  actor: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  role: AuditRole;
  action: string;
  targetType: string;
  targetId: string;
  details: Record<string, unknown>;
  requestId: string | null;
  /** The caller's address as the API saw it (the real client only if TRUST_PROXY names the gateway). */
  clientIp: string | null;
}

export interface AuditPage {
  items: AuditEntry[];
  /** Pass as `before` to get the next (older) page; null when there is none. */
  nextBefore: string | null;
}

interface Row {
  id: string; // bigserial arrives as a string
  at: Date;
  actor: string;
  role: AuditRole;
  action: string;
  target_type: string;
  target_id: string;
  details: Record<string, unknown>;
  request_id: string | null;
  client_ip: string | null;
}

export class AuditRepository {
  constructor(private readonly db: Db) {}

  /**
   * Records an action. Pass the TRANSACTION the action runs in, so the record and the action
   * commit or roll back together. Never put payloads or secrets in `details`.
   */
  async record(
    q: Queryable,
    principal: AuditActor,
    entry: {
      action: string;
      targetType: string;
      targetId: string;
      details?: Record<string, unknown>;
      requestId?: string | undefined;
      clientIp?: string | undefined;
      /** The customer organisation this belongs to (null for operator-plane actions on no account). */
      account?: string | undefined;
    },
  ): Promise<void> {
    await q.query(
      `INSERT INTO audit_log (actor, role, action, target_type, target_id, details, request_id, client_ip, account)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        principal.actor,
        principal.role,
        entry.action,
        entry.targetType,
        entry.targetId,
        JSON.stringify(entry.details ?? {}),
        entry.requestId ?? null,
        entry.clientIp ?? null,
        entry.account ?? null,
      ],
    );
  }

  /** Newest first. `before` is the id of the oldest entry already seen. */
  async list(limit: number, before?: string, account?: string): Promise<AuditPage> {
    const result = await this.db.query<Row>(
      `SELECT id, at, actor, role, action, target_type, target_id, details, request_id, client_ip
       FROM audit_log
       WHERE ($2::bigint IS NULL OR id < $2::bigint) AND ($3::text IS NULL OR account = $3)
       ORDER BY id DESC
       LIMIT $1`,
      [limit + 1, before ?? null, account ?? null],
    );
    const hasMore = result.rows.length > limit;
    const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
    return {
      items: rows.map((r) => ({
        id: r.id,
        at: r.at.toISOString(),
        actor: r.actor,
        role: r.role,
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        details: r.details,
        requestId: r.request_id,
        clientIp: r.client_ip,
      })),
      nextBefore: hasMore ? rows[rows.length - 1]!.id : null,
    };
  }
}
