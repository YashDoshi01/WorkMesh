import { Router, type Request, type Response } from "express";
import { logInfo, logWarn } from "@workmesh/shared";
import type { Db } from "../db/pool.js";
import { HttpError } from "../http/errors.js";
import { clientIp } from "../http/middleware.js";
import { parse } from "../http/validate.js";
import type { JobLifecycle } from "../jobs/lifecycle.js";
import { InvalidCursorError, type JobRepository } from "../jobs/repository.js";
import { createJobSchema, jobIdSchema, listJobsQuerySchema } from "../jobs/schema.js";
import type { ApiKeyRepository } from "../keys/repository.js";
import type { ActionResult, OpsActions } from "../ops/actions.js";
import type { AuditRepository } from "../ops/audit.js";
import { WORKER_STALE_AFTER_MS, type OpsQueries } from "../ops/queries.js";
import {
  createScheduleSchema,
  listSchedulesQuerySchema,
  patchScheduleSchema,
} from "../schedules/schema.js";
import { ScheduleNameTakenError, type ScheduleRepository } from "../schedules/repository.js";
import type { WorkflowRepository } from "../workflows/repository.js";
import { listWorkflowsQuerySchema } from "../workflows/schema.js";
import {
  SESSION_COOKIE,
  clearedCookie,
  csrfGuard,
  readCookie,
  requireAdmin,
  requireSession,
  sessionCookie,
  userOf,
} from "./guard.js";
import { dummyHash, passwordProblem, verifyPassword, type ScryptCost } from "./passwords.js";
import {
  acceptInviteSchema,
  auditQuerySchema,
  changePasswordSchema,
  changeRoleSchema,
  createAppKeySchema,
  createInviteSchema,
  inviteTokenSchema,
  loginSchema,
  overviewQuerySchema,
  retryBodySchema,
  signupSchema,
  workersQuerySchema,
} from "./schema.js";
import type { PortalStore, User } from "./store.js";

export interface PortalOptions {
  /** Hours a login stays valid. */
  sessionTtlHours: number;
  /** Send the session cookie with the Secure flag (needed once the site is served over HTTPS). */
  cookieSecure: boolean;
  /** May anyone create a new organisation? Turn off for an invitation-only deployment. */
  publicSignup: boolean;
  cost: ScryptCost;
}

export interface PortalDeps {
  db: Db;
  options: PortalOptions;
  store: PortalStore;
  actions: OpsActions;
  audit: AuditRepository;
  queries: OpsQueries;
  jobs: JobRepository;
  lifecycle: JobLifecycle;
  workflows: WorkflowRepository;
  schedules: ScheduleRepository;
  keys: ApiKeyRepository;
}

const GENERIC_LOGIN_FAILURE = "Invalid email or password, or the account is temporarily locked";

function unwrap<T>(result: ActionResult<T>, what: string): T {
  if (result.outcome === "ok") return result.value;
  if (result.outcome === "not_found")
    throw new HttpError(404, `${what}_not_found`, `No such ${what}`);
  throw new HttpError(409, result.code, result.message);
}

const publicUser = (u: User) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  createdAt: u.createdAt,
  lastLoginAt: u.lastLoginAt,
});
const identity = (u: User) => ({
  user: publicUser(u),
  account: { slug: u.account, name: u.accountName },
});

/**
 * The customer-facing API: people sign in with an email and password and see ONLY their own
 * organisation. Two roles: `admin` (can change things, manage keys and members) and `viewer`
 * (read-only). Every handler takes the organisation from the SESSION, never from the request, so
 * there is no parameter a user could change to reach another organisation's data.
 */
export function portalRoutes(d: PortalDeps): Router {
  const router = Router();
  const { store, options } = d;
  const authed = requireSession(store);

  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.use(csrfGuard);

  const ctx = (req: Request) => {
    const user = userOf(req);
    return {
      principal: { role: user.role, actor: `user:${user.email}` },
      account: user.account,
      requestId: req.requestId,
      clientIp: clientIp(req),
    };
  };

  const startSession = async (req: Request, res: Response, user: User): Promise<void> => {
    const { token, maxAgeSeconds } = await store.createSession(
      user.id,
      clientIp(req),
      req.header("user-agent"),
    );
    res.setHeader("Set-Cookie", sessionCookie(token, maxAgeSeconds, options.cookieSecure));
  };

  // ============================================================== authentication
  router.post("/auth/signup", async (req, res) => {
    if (!options.publicSignup)
      throw new HttpError(403, "signup_disabled", "Sign-up is by invitation only");
    const input = parse(signupSchema, req.body, "sign-up");
    const problem = passwordProblem(input.password, input.email);
    if (problem)
      throw new HttpError(400, "validation_error", "Invalid sign-up", [
        { path: "password", message: problem },
      ]);
    const user = await store.signup(input);
    await startSession(req, res, user);
    await audit(req, user, "user.signup", "account", user.account, {
      organisation: user.accountName,
    });
    logInfo("user_signed_up", { requestId: req.requestId, account: user.account });
    res.status(201).json(identity(user));
  });

  router.post("/auth/login", async (req, res) => {
    const { email, password } = parse(loginSchema, req.body, "login");
    const found = await store.findForLogin(email);
    // Unknown email: verify against a throwaway hash so the time taken does not reveal it.
    const matches = await verifyPassword(
      password,
      found?.passwordHash ?? (await dummyHash(options.cost)),
    );
    const reason = !found
      ? "unknown_email"
      : found.disabled
        ? "disabled"
        : found.locked
          ? "locked"
          : !matches
            ? "wrong_password"
            : null;
    if (reason || !found) {
      if (found && reason === "wrong_password") await store.recordLoginFailure(found.id);
      logWarn("login_failed", { requestId: req.requestId, ip: clientIp(req), reason });
      throw new HttpError(401, "invalid_credentials", GENERIC_LOGIN_FAILURE);
    }
    await store.recordLoginSuccess(found.id);
    await startSession(req, res, found);
    logInfo("user_logged_in", { requestId: req.requestId, account: found.account });
    res.json(identity(found));
  });

  router.post("/auth/logout", async (req, res) => {
    const token = req.header("cookie")?.match(/wm_session=([^;]+)/)?.[1];
    if (token) await store.revokeSession(decodeURIComponent(token));
    res.setHeader("Set-Cookie", clearedCookie(options.cookieSecure));
    res.json({ ok: true });
  });

  // For the app's first request: "am I signed in?". Unlike /auth/me this answers 200 either way, so
  // a visitor's browser does not log a failed (401) request on every page load.
  router.get("/auth/session", async (req, res) => {
    const token = readCookie(req.header("cookie"), SESSION_COOKIE);
    const user = token ? await store.findSession(token) : null;
    res.json({ me: user ? identity(user) : null });
  });

  router.get("/auth/me", authed, (req, res) => {
    res.json(identity(userOf(req)));
  });

  router.post("/auth/invite-info", async (req, res) => {
    const { token } = parse(inviteTokenSchema, req.body, "invitation");
    const preview = await store.previewInvite(token);
    if (!preview)
      throw new HttpError(404, "invalid_invite", "This invitation is not valid any more");
    res.json(preview);
  });

  router.post("/auth/accept-invite", async (req, res) => {
    const input = parse(acceptInviteSchema, req.body, "invitation");
    const preview = await store.previewInvite(input.token);
    if (!preview)
      throw new HttpError(400, "invalid_invite", "This invitation is not valid any more");
    const problem = passwordProblem(input.password, preview.email);
    if (problem)
      throw new HttpError(400, "validation_error", "Invalid password", [
        { path: "password", message: problem },
      ]);
    const user = await store.acceptInvite(input.token, input.name, input.password);
    await startSession(req, res, user);
    await audit(req, user, "member.join", "user", user.id, { role: user.role });
    res.status(201).json(identity(user));
  });

  router.post("/auth/change-password", authed, async (req, res) => {
    const me = userOf(req);
    const { currentPassword, newPassword } = parse(
      changePasswordSchema,
      req.body,
      "password change",
    );
    const hash = await store.userPasswordHash(me.id);
    if (!hash || !(await verifyPassword(currentPassword, hash))) {
      throw new HttpError(400, "validation_error", "Invalid password change", [
        { path: "currentPassword", message: "is not correct" },
      ]);
    }
    const problem = passwordProblem(newPassword, me.email);
    if (problem)
      throw new HttpError(400, "validation_error", "Invalid password change", [
        { path: "newPassword", message: problem },
      ]);
    await store.setPassword(me.id, newPassword);
    // A changed password ends every OTHER session (a stolen one stops working).
    await store.revokeUserSessions(me.id, me.sessionId);
    await audit(req, me, "user.password_change", "user", me.id);
    res.json({ ok: true });
  });

  // =================================================================== read-only
  router.get("/overview", authed, async (req, res) => {
    const { windowMinutes } = parse(overviewQuerySchema, req.query, "query parameters");
    res.json(await d.queries.stats(windowMinutes, userOf(req).account));
  });

  router.get("/workers", authed, async (req, res) => {
    const { limit } = parse(workersQuerySchema, req.query, "query parameters");
    res.json({
      staleAfterMs: WORKER_STALE_AFTER_MS,
      items: await d.queries.workers(limit, userOf(req).account),
    });
  });

  router.get("/jobs", authed, async (req, res) => {
    const query = parse(listJobsQuerySchema, req.query, "query parameters");
    try {
      res.json(await d.jobs.list({ ...query, account: userOf(req).account }));
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        throw new HttpError(400, "validation_error", "Invalid query parameters", [
          { path: "cursor", message: err.message },
        ]);
      }
      throw err;
    }
  });

  const ownedJob = async (req: Request, id: string) => {
    const job = await d.jobs.findById(id);
    if (!job || job.account !== userOf(req).account)
      throw new HttpError(404, "job_not_found", `Job ${id} does not exist`);
    return job;
  };

  router.get("/jobs/:id", authed, async (req, res) => {
    res.json(await ownedJob(req, parse(jobIdSchema, req.params.id, "job id")));
  });

  router.get("/jobs/:id/attempts", authed, async (req, res) => {
    const id = parse(jobIdSchema, req.params.id, "job id");
    await ownedJob(req, id);
    const attempts = await d.lifecycle.attempts(id);
    if (!attempts) throw new HttpError(404, "job_not_found", `Job ${id} does not exist`);
    res.json({ items: attempts });
  });

  const ownedWorkflow = async (req: Request, id: string) => {
    const wf = await d.workflows.findById(id);
    if (!wf || wf.account !== userOf(req).account)
      throw new HttpError(404, "workflow_not_found", `Workflow ${id} does not exist`);
    return wf;
  };

  router.get("/workflows", authed, async (req, res) => {
    const query = parse(listWorkflowsQuerySchema, req.query, "query parameters");
    res.json({ items: await d.workflows.list({ ...query, account: userOf(req).account }) });
  });

  router.get("/workflows/:id", authed, async (req, res) => {
    res.json(await ownedWorkflow(req, parse(jobIdSchema, req.params.id, "workflow id")));
  });

  const ownedSchedule = async (req: Request, id: string) => {
    const s = await d.schedules.findById(id);
    if (!s || s.account !== userOf(req).account)
      throw new HttpError(404, "schedule_not_found", `Schedule ${id} does not exist`);
    return s;
  };

  router.get("/schedules", authed, async (req, res) => {
    const { limit } = parse(listSchedulesQuerySchema, req.query, "query parameters");
    res.json({ items: await d.schedules.list(limit, userOf(req).account) });
  });

  router.get("/schedules/:id", authed, async (req, res) => {
    res.json(await ownedSchedule(req, parse(jobIdSchema, req.params.id, "schedule id")));
  });

  router.get("/keys", authed, async (req, res) => {
    res.json({ items: await d.keys.list(userOf(req).account) });
  });

  router.get("/members", authed, async (req, res) => {
    res.json({ items: (await store.listMembers(userOf(req).account)).map(publicUser) });
  });

  // =============================================================== admin: changes
  router.post("/jobs", authed, requireAdmin, async (req, res) => {
    const input = parse(createJobSchema, req.body, "job");
    const job = await d.actions.submitJob(ctx(req), input, userOf(req).account);
    res.status(201).json(job);
  });

  router.post("/jobs/:id/cancel", authed, requireAdmin, async (req, res) => {
    const id = parse(jobIdSchema, req.params.id, "job id");
    await ownedJob(req, id);
    res.json(unwrap(await d.actions.cancelJob(ctx(req), id), "job"));
  });

  router.post("/jobs/:id/retry", authed, requireAdmin, async (req, res) => {
    const id = parse(jobIdSchema, req.params.id, "job id");
    const { attempts } = parse(retryBodySchema, req.body ?? {}, "retry request");
    await ownedJob(req, id);
    res.json(unwrap(await d.actions.retryJob(ctx(req), id, attempts), "job"));
  });

  router.post("/workflows/:id/cancel", authed, requireAdmin, async (req, res) => {
    const id = parse(jobIdSchema, req.params.id, "workflow id");
    await ownedWorkflow(req, id);
    res.json(unwrap(await d.actions.cancelWorkflow(ctx(req), id), "workflow"));
  });

  router.post("/schedules", authed, requireAdmin, async (req, res) => {
    const input = parse(createScheduleSchema, req.body, "schedule");
    try {
      res.status(201).json(await d.actions.createSchedule(ctx(req), input, userOf(req).account));
    } catch (err) {
      if (err instanceof ScheduleNameTakenError) {
        throw new HttpError(409, "schedule_name_taken", `A schedule named "${input.name}" exists`);
      }
      throw err;
    }
  });

  router.patch("/schedules/:id", authed, requireAdmin, async (req, res) => {
    const id = parse(jobIdSchema, req.params.id, "schedule id");
    const { enabled } = parse(patchScheduleSchema, req.body, "schedule update");
    await ownedSchedule(req, id);
    res.json(unwrap(await d.actions.setScheduleEnabled(ctx(req), id, enabled), "schedule"));
  });

  router.delete("/schedules/:id", authed, requireAdmin, async (req, res) => {
    const id = parse(jobIdSchema, req.params.id, "schedule id");
    await ownedSchedule(req, id);
    unwrap(await d.actions.deleteSchedule(ctx(req), id), "schedule");
    res.status(204).end();
  });

  // ---------------------------------------------------------------- API keys
  router.post("/keys", authed, requireAdmin, async (req, res) => {
    const input = parse(createAppKeySchema, req.body, "API key");
    const { key, secret } = await d.actions.createKey(ctx(req), {
      ...input,
      account: userOf(req).account,
    });
    // The only time the secret is ever shown.
    res.status(201).json({ ...key, secret });
  });

  router.post("/keys/:id/revoke", authed, requireAdmin, async (req, res) => {
    const id = parse(jobIdSchema, req.params.id, "key id");
    const key = await d.keys.findById(id);
    if (!key || key.account !== userOf(req).account)
      throw new HttpError(404, "key_not_found", "No such key");
    res.json(unwrap(await d.actions.revokeKey(ctx(req), id), "key"));
  });

  // ------------------------------------------------------------- team members
  router.get("/invites", authed, requireAdmin, async (req, res) => {
    res.json({ items: await store.listInvites(userOf(req).account) });
  });

  router.post("/invites", authed, requireAdmin, async (req, res) => {
    const me = userOf(req);
    const { email, role } = parse(createInviteSchema, req.body, "invitation");
    const { invite, token } = await store.createInvite(me.account, email, role, me.id);
    await audit(req, me, "member.invite", "invite", invite.id, { email: invite.email, role });
    // The token is shown ONCE; there is no email service, so the admin hands the link over.
    res.status(201).json({ ...invite, token });
  });

  router.post("/invites/:id/revoke", authed, requireAdmin, async (req, res) => {
    const me = userOf(req);
    const id = parse(jobIdSchema, req.params.id, "invitation id");
    const invite = await store.revokeInvite(me.account, id);
    await audit(req, me, "member.invite_revoke", "invite", id, { email: invite.email });
    res.json(invite);
  });

  router.patch("/members/:id", authed, requireAdmin, async (req, res) => {
    const me = userOf(req);
    const id = parse(jobIdSchema, req.params.id, "member id");
    const { role } = parse(changeRoleSchema, req.body, "role change");
    const updated = await store.changeRole(me.account, id, role);
    await audit(req, me, "member.role_change", "user", id, { email: updated.email, role });
    res.json(publicUser(updated));
  });

  router.delete("/members/:id", authed, requireAdmin, async (req, res) => {
    const me = userOf(req);
    const id = parse(jobIdSchema, req.params.id, "member id");
    const removed = await store.removeMember(me.account, id);
    await audit(req, me, "member.remove", "user", id, { email: removed.email });
    res.status(204).end();
  });

  // -------------------------------------------------------------------- audit
  router.get("/audit", authed, requireAdmin, async (req, res) => {
    const { limit, before } = parse(auditQuerySchema, req.query, "query parameters");
    res.json(await d.audit.list(limit, before, userOf(req).account));
  });

  /** Audit records for account-level events that are not covered by an OpsActions transaction. */
  async function audit(
    req: Request,
    user: User,
    action: string,
    targetType: string,
    targetId: string,
    details: Record<string, unknown> = {},
  ) {
    await d.audit.record(
      d.db,
      { role: user.role, actor: `user:${user.email}` },
      {
        action,
        targetType,
        targetId,
        details,
        requestId: req.requestId,
        clientIp: clientIp(req),
        account: user.account,
      },
    );
  }

  return router;
}
