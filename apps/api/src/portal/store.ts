import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../db/pool.js";
import { withTransaction, type Queryable } from "../db/tx.js";
import { HttpError } from "../http/errors.js";
import { hashPassword, type ScryptCost } from "./passwords.js";

export type MemberRole = "admin" | "viewer";

export interface User {
  id: string;
  email: string;
  name: string;
  account: string;
  accountName: string;
  role: MemberRole;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface SessionUser extends User {
  sessionId: string;
}

export interface Invite {
  id: string;
  email: string;
  role: MemberRole;
  invitedBy: string | null;
  createdAt: string;
  expiresAt: string;
  status: "open" | "accepted" | "revoked" | "expired";
}

const sha256 = (value: string): Buffer => createHash("sha256").update(value).digest();
const newToken = (): string => randomBytes(32).toString("base64url");

/** After this many wrong passwords in a row the account is locked for LOCK_MINUTES. */
export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;
const INVITE_DAYS = 7;

interface UserRow {
  id: string;
  email: string;
  name: string;
  account: string;
  account_name: string;
  role: MemberRole;
  created_at: Date;
  last_login_at: Date | null;
}

const USER_COLUMNS = `u.id, u.email, u.name, u.account, a.name AS account_name, u.role, u.created_at, u.last_login_at`;
const USER_FROM = `FROM users u JOIN accounts a ON a.slug = u.account`;

const toUser = (r: UserRow): User => ({
  id: r.id,
  email: r.email,
  name: r.name,
  account: r.account,
  accountName: r.account_name,
  role: r.role,
  createdAt: r.created_at.toISOString(),
  lastLoginAt: r.last_login_at?.toISOString() ?? null,
});

/** "Acme Corp, Inc." -> "acme-corp-inc". Always matches the account slug rule or is empty. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export class PortalStore {
  constructor(
    private readonly db: Db,
    private readonly options: { sessionTtlHours: number; cost: ScryptCost },
  ) {}

  // -------------------------------------------------------------------- sign-up
  /** Creates an organisation and its first admin, in one transaction. */
  async signup(input: {
    orgName: string;
    email: string;
    name: string;
    password: string;
  }): Promise<User> {
    const email = normalizeEmail(input.email);
    const passwordHash = await hashPassword(input.password, this.options.cost);
    const base = slugify(input.orgName) || "org";
    return withTransaction(this.db, async (tx) => {
      let slug = base;
      for (let attempt = 0; attempt < 8; attempt++) {
        if (!(await this.slugInUse(tx, slug))) break;
        slug = `${base.slice(0, 35)}-${randomBytes(2).toString("hex")}`;
        if (attempt === 7)
          throw new HttpError(
            409,
            "account_name_unavailable",
            "Please choose another organisation name",
          );
      }
      try {
        await tx.query("SAVEPOINT signup");
        await tx.query(`INSERT INTO accounts (slug, name) VALUES ($1, $2)`, [
          slug,
          input.orgName.trim(),
        ]);
        const created = await tx.query<{ id: string }>(
          `INSERT INTO users (email, name, password_hash, account, role)
           VALUES ($1, $2, $3, $4, 'admin') RETURNING id`,
          [email, input.name.trim(), passwordHash, slug],
        );
        return (await this.userById(tx, created.rows[0]!.id))!;
      } catch (err) {
        if ((err as { code?: string }).code === "23505") {
          throw new HttpError(409, "email_taken", "An account with this email already exists");
        }
        throw err;
      }
    });
  }

  /** An account name is "in use" if any table already holds data under that label. */
  private async slugInUse(q: Queryable, slug: string): Promise<boolean> {
    const r = await q.query(
      `SELECT 1 FROM accounts WHERE slug = $1
       UNION ALL SELECT 1 FROM api_keys WHERE account = $1
       UNION ALL (SELECT 1 FROM jobs WHERE account = $1 LIMIT 1)
       LIMIT 1`,
      [slug],
    );
    return (r.rowCount ?? 0) > 0;
  }

  // ---------------------------------------------------------------------- login
  async findForLogin(
    email: string,
  ): Promise<(User & { passwordHash: string; locked: boolean; disabled: boolean }) | null> {
    const r = await this.db.query<
      UserRow & { password_hash: string; locked: boolean; disabled: boolean }
    >(
      `SELECT ${USER_COLUMNS}, u.password_hash,
              (u.locked_until IS NOT NULL AND u.locked_until > now()) AS locked,
              (u.disabled_at IS NOT NULL) AS disabled
       ${USER_FROM} WHERE u.email = $1`,
      [normalizeEmail(email)],
    );
    const row = r.rows[0];
    return row
      ? {
          ...toUser(row),
          passwordHash: row.password_hash,
          locked: row.locked,
          disabled: row.disabled,
        }
      : null;
  }

  /** Counts a wrong password; the fifth in a row locks the account. */
  async recordLoginFailure(userId: string): Promise<void> {
    await this.db.query(
      `UPDATE users SET
         locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END,
         failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END
       WHERE id = $1`,
      [userId, MAX_FAILED_LOGINS, LOCK_MINUTES],
    );
  }

  async recordLoginSuccess(userId: string): Promise<void> {
    await this.db.query(
      `UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`,
      [userId],
    );
  }

  // ------------------------------------------------------------------- sessions
  async createSession(
    userId: string,
    ip: string | undefined,
    userAgent: string | undefined,
  ): Promise<{ token: string; maxAgeSeconds: number }> {
    const token = newToken();
    await this.db.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent)
       VALUES ($1, $2, now() + make_interval(hours => $3), $4, $5)`,
      [
        sha256(token),
        userId,
        this.options.sessionTtlHours,
        ip?.slice(0, 64) ?? null,
        userAgent?.slice(0, 200) ?? null,
      ],
    );
    return { token, maxAgeSeconds: this.options.sessionTtlHours * 3600 };
  }

  /** The user behind a session token, or null if it is unknown, revoked, expired, or the user is disabled. */
  async findSession(token: string): Promise<SessionUser | null> {
    const r = await this.db.query<UserRow & { session_id: string; touch_due: boolean }>(
      `SELECT ${USER_COLUMNS}, s.id AS session_id,
              (s.last_seen_at < now() - interval '5 minutes') AS touch_due
       FROM sessions s JOIN users u ON u.id = s.user_id JOIN accounts a ON a.slug = u.account
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.disabled_at IS NULL`,
      [sha256(token)],
    );
    const row = r.rows[0];
    if (!row) return null;
    if (row.touch_due) {
      await this.db.query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [
        row.session_id,
      ]);
    }
    return { ...toUser(row), sessionId: row.session_id };
  }

  async revokeSession(token: string): Promise<void> {
    await this.db.query(
      `UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
      [sha256(token)],
    );
  }

  async revokeUserSessions(userId: string, exceptSessionId?: string): Promise<void> {
    await this.db.query(
      `UPDATE sessions SET revoked_at = now()
       WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2)`,
      [userId, exceptSessionId ?? null],
    );
  }

  async userPasswordHash(userId: string): Promise<string | null> {
    const r = await this.db.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE id = $1`,
      [userId],
    );
    return r.rows[0]?.password_hash ?? null;
  }

  async setPassword(userId: string, newPassword: string): Promise<void> {
    const hash = await hashPassword(newPassword, this.options.cost);
    await this.db.query(
      `UPDATE users SET password_hash = $2, failed_logins = 0, locked_until = NULL WHERE id = $1`,
      [userId, hash],
    );
  }

  private async userById(q: Queryable, id: string): Promise<User | null> {
    const r = await q.query<UserRow>(`SELECT ${USER_COLUMNS} ${USER_FROM} WHERE u.id = $1`, [id]);
    return r.rows[0] ? toUser(r.rows[0]) : null;
  }

  // -------------------------------------------------------------------- members
  async listMembers(account: string): Promise<User[]> {
    const r = await this.db.query<UserRow>(
      `SELECT ${USER_COLUMNS} ${USER_FROM} WHERE u.account = $1 AND u.disabled_at IS NULL ORDER BY u.created_at, u.id`,
      [account],
    );
    return r.rows.map(toUser);
  }

  /** Changes a member's role. The organisation must always keep at least one admin. */
  async changeRole(account: string, userId: string, role: MemberRole): Promise<User> {
    return withTransaction(this.db, async (tx) => {
      const admins = await this.lockAdmins(tx, account);
      const target = await tx.query<{ role: MemberRole }>(
        `SELECT role FROM users WHERE id = $1 AND account = $2 AND disabled_at IS NULL`,
        [userId, account],
      );
      if (!target.rows[0]) throw new HttpError(404, "member_not_found", "No such member");
      if (target.rows[0].role === "admin" && role !== "admin" && admins.length <= 1) {
        throw new HttpError(409, "last_admin", "An organisation needs at least one admin");
      }
      await tx.query(`UPDATE users SET role = $2 WHERE id = $1`, [userId, role]);
      return (await this.userById(tx, userId))!;
    });
  }

  /** Removes a member (and ends their sessions). The last admin cannot be removed. */
  async removeMember(account: string, userId: string): Promise<User> {
    return withTransaction(this.db, async (tx) => {
      const admins = await this.lockAdmins(tx, account);
      const target = await this.userById(tx, userId);
      if (!target || target.account !== account)
        throw new HttpError(404, "member_not_found", "No such member");
      if (target.role === "admin" && admins.length <= 1) {
        throw new HttpError(409, "last_admin", "An organisation needs at least one admin");
      }
      await tx.query(`DELETE FROM users WHERE id = $1`, [userId]);
      return target;
    });
  }

  /** Locks the account's admin rows so two concurrent demotions cannot both succeed. */
  private async lockAdmins(tx: Queryable, account: string): Promise<string[]> {
    const r = await tx.query<{ id: string }>(
      `SELECT id FROM users WHERE account = $1 AND role = 'admin' AND disabled_at IS NULL ORDER BY id FOR UPDATE`,
      [account],
    );
    return r.rows.map((x) => x.id);
  }

  // -------------------------------------------------------------------- invites
  async createInvite(
    account: string,
    email: string,
    role: MemberRole,
    invitedBy: string,
  ): Promise<{ invite: Invite; token: string }> {
    const normalized = normalizeEmail(email);
    const token = newToken();
    return withTransaction(this.db, async (tx) => {
      const existing = await tx.query(`SELECT 1 FROM users WHERE email = $1`, [normalized]);
      if ((existing.rowCount ?? 0) > 0)
        throw new HttpError(409, "email_taken", "That email already has an account");
      // An expired open invitation must not block a new one: close it first.
      await tx.query(
        `UPDATE invites SET revoked_at = now() WHERE account = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= now()`,
        [account, normalized],
      );
      try {
        await tx.query("SAVEPOINT invite");
        const r = await tx.query<InviteRow>(
          `INSERT INTO invites (token_hash, account, email, role, invited_by, expires_at)
           VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6))
           RETURNING ${INVITE_COLUMNS}`,
          [sha256(token), account, normalized, role, invitedBy, INVITE_DAYS],
        );
        return { invite: toInvite(r.rows[0]!), token };
      } catch (err) {
        if ((err as { code?: string }).code === "23505") {
          throw new HttpError(
            409,
            "invite_exists",
            "There is already an open invitation for that email",
          );
        }
        throw err;
      }
    });
  }

  async listInvites(account: string): Promise<Invite[]> {
    const r = await this.db.query<InviteRow>(
      `SELECT ${INVITE_COLUMNS} FROM invites WHERE account = $1 AND accepted_at IS NULL ORDER BY created_at DESC LIMIT 100`,
      [account],
    );
    return r.rows.map(toInvite);
  }

  async revokeInvite(account: string, id: string): Promise<Invite> {
    const r = await this.db.query<InviteRow>(
      `UPDATE invites SET revoked_at = now() WHERE id = $1 AND account = $2 AND accepted_at IS NULL AND revoked_at IS NULL
       RETURNING ${INVITE_COLUMNS}`,
      [id, account],
    );
    if (!r.rows[0]) throw new HttpError(404, "invite_not_found", "No such open invitation");
    return toInvite(r.rows[0]);
  }

  /** What a person sees before choosing a password. Reveals nothing for an invalid token. */
  async previewInvite(
    token: string,
  ): Promise<{ email: string; role: MemberRole; accountName: string } | null> {
    const r = await this.db.query<{ email: string; role: MemberRole; account_name: string }>(
      `SELECT i.email, i.role, a.name AS account_name FROM invites i JOIN accounts a ON a.slug = i.account
       WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()`,
      [sha256(token)],
    );
    const row = r.rows[0];
    return row ? { email: row.email, role: row.role, accountName: row.account_name } : null;
  }

  async acceptInvite(token: string, name: string, password: string): Promise<User> {
    const passwordHash = await hashPassword(password, this.options.cost);
    return withTransaction(this.db, async (tx) => {
      const r = await tx.query<{ id: string; account: string; email: string; role: MemberRole }>(
        `SELECT id, account, email, role FROM invites
         WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`,
        [sha256(token)],
      );
      const invite = r.rows[0];
      if (!invite)
        throw new HttpError(400, "invalid_invite", "This invitation is not valid any more");
      try {
        await tx.query("SAVEPOINT accept");
        const created = await tx.query<{ id: string }>(
          `INSERT INTO users (email, name, password_hash, account, role) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [invite.email, name.trim(), passwordHash, invite.account, invite.role],
        );
        await tx.query(`UPDATE invites SET accepted_at = now() WHERE id = $1`, [invite.id]);
        return (await this.userById(tx, created.rows[0]!.id))!;
      } catch (err) {
        if ((err as { code?: string }).code === "23505") {
          throw new HttpError(409, "email_taken", "That email already has an account");
        }
        throw err;
      }
    });
  }
}

interface InviteRow {
  id: string;
  email: string;
  role: MemberRole;
  invited_by: string | null;
  created_at: Date;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
  expired: boolean;
}

const INVITE_COLUMNS = `id, email, role, invited_by, created_at, expires_at, accepted_at, revoked_at, (expires_at <= now()) AS expired`;

function toInvite(r: InviteRow): Invite {
  return {
    id: r.id,
    email: r.email,
    role: r.role,
    invitedBy: r.invited_by,
    createdAt: r.created_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    status: r.accepted_at ? "accepted" : r.revoked_at ? "revoked" : r.expired ? "expired" : "open",
  };
}
