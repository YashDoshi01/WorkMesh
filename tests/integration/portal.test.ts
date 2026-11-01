import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Db } from "@workmesh/api";
import { portalRoutes } from "../../apps/api/src/portal/routes.js";
import { PortalStore } from "../../apps/api/src/portal/store.js";
import {
  OPERATOR_KEY,
  PORTAL_AUTH,
  api,
  resetTables,
  setupTestDb,
  startApi,
  stopApi,
  type Started,
} from "./helpers.js";

const PASSWORD = "correct horse battery";
const ghostId = "00000000-0000-4000-8000-000000000000";

type Reply = { status: number; body: any; headers: Headers };

/** A browser stand-in: keeps the session cookie and sends the CSRF header like the real app. */
class Browser {
  cookie = "";
  constructor(private readonly base: string) {}

  async call(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
    csrf = true,
  ): Promise<Reply> {
    const headers: Record<string, string> = { ...extra };
    if (this.cookie) headers.cookie = this.cookie;
    if (csrf) headers["x-workmesh-csrf"] = "1";
    const r = await api(this.base, method, path, body, headers);
    const set = r.headers.get("set-cookie");
    if (set)
      this.cookie =
        set.startsWith("wm_session=;") || /Max-Age=0/.test(set) ? "" : set.split(";")[0]!;
    return r;
  }
  get = (path: string) => this.call("GET", path);
  post = (path: string, body: unknown = {}) => this.call("POST", path, body);
  patch = (path: string, body: unknown) => this.call("PATCH", path, body);
  del = (path: string) => this.call("DELETE", path);
}

describe("customer accounts (PostgreSQL)", () => {
  let db: Db;
  let a: Started;
  let b: Started;

  before(async () => {
    db = await setupTestDb();
    // Two instances: a session created through one must work through the other.
    a = await startApi(db, {}, PORTAL_AUTH);
    b = await startApi(db, {}, PORTAL_AUTH);
  });
  beforeEach(() => resetTables(db));
  after(async () => {
    await stopApi(a.server);
    await stopApi(b.server);
    await db.end();
  });

  const signup = async (
    org: string,
    email: string,
    password = PASSWORD,
    start: Started = a,
  ): Promise<{ browser: Browser; reply: Reply }> => {
    const browser = new Browser(start.url);
    const reply = await browser.post("/app/auth/signup", {
      orgName: org,
      name: "Test User",
      email,
      password,
    });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    return { browser, reply };
  };

  /** An admin invites someone; the invitee accepts and is signed in. */
  const addMember = async (
    admin: Browser,
    email: string,
    role: "admin" | "viewer",
  ): Promise<Browser> => {
    const invite = await admin.post("/app/invites", { email, role });
    assert.equal(invite.status, 201, JSON.stringify(invite.body));
    const member = new Browser(a.url);
    const accepted = await member.post("/app/auth/accept-invite", {
      token: invite.body.token,
      name: "Member",
      password: PASSWORD,
    });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    return member;
  };

  /** Captures everything the process writes to the console while `fn` runs. */
  const captureLogs = async <T>(fn: () => Promise<T>): Promise<{ result: T; text: string }> => {
    const lines: string[] = [];
    const originals = { log: console.log, warn: console.warn, error: console.error };
    const grab = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    console.log = grab;
    console.warn = grab;
    console.error = grab;
    try {
      return { result: await fn(), text: lines.join("\n") };
    } finally {
      Object.assign(console, originals);
    }
  };

  // ============================================================ sign-up and sign-in
  describe("sign-up and sign-in", () => {
    it("sign-up creates an organisation and its first admin, and signs them in with a safe cookie", async () => {
      const { browser, reply } = await signup("Acme Corp", "Founder@Example.com");
      assert.equal(reply.body.user.email, "founder@example.com", "emails are stored lower-case");
      assert.equal(reply.body.user.role, "admin");
      assert.equal(reply.body.account.slug, "acme-corp");
      assert.equal(reply.body.account.name, "Acme Corp");
      const cookie = reply.headers.get("set-cookie") ?? "";
      assert.match(cookie, /^wm_session=/);
      assert.match(cookie, /HttpOnly/i, "page scripts cannot read it");
      assert.match(cookie, /SameSite=Lax/i);
      assert.match(cookie, /Max-Age=86400/);
      assert.ok(!/Secure/i.test(cookie), "not Secure over plain http in this configuration");
      const me = await browser.get("/app/auth/me");
      assert.equal(me.status, 200);
      assert.equal(me.body.user.email, "founder@example.com");
      assert.ok(!JSON.stringify(me.body).includes("password"), "no password material in responses");
    });

    it("the password is stored as a scrypt hash and the session token only as a digest", async () => {
      const { browser } = await signup("Acme", "a@example.com");
      const user = (await db.query("SELECT password_hash FROM users")).rows[0];
      assert.match(user.password_hash, /^scrypt\$\d+\$\d+\$\d+\$/);
      assert.ok(!user.password_hash.includes(PASSWORD));
      const token = decodeURIComponent(browser.cookie.split("=")[1]!);
      const stored = (await db.query("SELECT token_hash FROM sessions")).rows[0];
      assert.equal(stored.token_hash.length, 32, "a SHA-256 digest");
      assert.ok(!stored.token_hash.toString("utf8").includes(token));
    });

    it("the session check answers 200 either way, so a visitor's browser logs no error", async () => {
      const visitor = await new Browser(a.url).get("/app/auth/session");
      assert.equal(visitor.status, 200);
      assert.deepEqual(visitor.body, { me: null });
      const { browser } = await signup("Acme", "a@example.com");
      const member = await browser.get("/app/auth/session");
      assert.equal(member.status, 200);
      assert.equal(member.body.me.user.email, "a@example.com");
      assert.equal(member.body.me.account.slug, "acme");
      await browser.post("/app/auth/logout");
      await db.query("UPDATE sessions SET revoked_at = now()");
      assert.deepEqual(
        (await browser.get("/app/auth/session")).body,
        { me: null },
        "a dead session is just 'nobody'",
      );
    });

    it("a session created through one instance works through the other", async () => {
      const { browser } = await signup("Acme", "a@example.com");
      const other = new Browser(b.url);
      other.cookie = browser.cookie;
      assert.equal((await other.get("/app/auth/me")).status, 200);
    });

    it("rejects weak or malformed sign-ups", async () => {
      const bad: Array<[string, object]> = [
        ["short password", { orgName: "X", name: "N", email: "a@example.com", password: "short" }],
        [
          "common password",
          { orgName: "X", name: "N", email: "a@example.com", password: "password123" },
        ],
        [
          "password equals email",
          {
            orgName: "X",
            name: "N",
            email: "someone@example.com",
            password: "someone@example.com",
          },
        ],
        [
          "one repeated character",
          { orgName: "X", name: "N", email: "a@example.com", password: "aaaaaaaaaaaa" },
        ],
        ["bad email", { orgName: "X", name: "N", email: "not-an-email", password: PASSWORD }],
        ["missing org", { name: "N", email: "a@example.com", password: PASSWORD }],
        [
          "unknown field",
          { orgName: "X", name: "N", email: "a@example.com", password: PASSWORD, role: "admin" },
        ],
        [
          "huge password",
          { orgName: "X", name: "N", email: "a@example.com", password: "x".repeat(500) },
        ],
      ];
      for (const [label, body] of bad) {
        const r = await new Browser(a.url).post("/app/auth/signup", body);
        assert.equal(r.status, 400, label);
        assert.equal(r.body.error.code, "validation_error", label);
      }
      assert.equal((await db.query("SELECT count(*)::int AS n FROM users")).rows[0].n, 0);
    });

    it("an email can only be used once", async () => {
      await signup("One", "same@example.com");
      const r = await new Browser(a.url).post("/app/auth/signup", {
        orgName: "Two",
        name: "N",
        email: "SAME@example.com",
        password: PASSWORD,
      });
      assert.equal(r.status, 409);
      assert.equal(r.body.error.code, "email_taken");
      assert.equal(
        (await db.query("SELECT count(*)::int AS n FROM accounts WHERE name = 'Two'")).rows[0].n,
        0,
        "no orphan organisation",
      );
    });

    it("an organisation name that matches data already in the system gets a different slug, and sees none of it", async () => {
      // 'acme' already exists through the machine plane (a key and a job), with no user behind it.
      const key = await api(
        a.url,
        "POST",
        "/ops/keys",
        { kind: "client", account: "acme", name: "k" },
        { authorization: `Bearer ${OPERATOR_KEY}` },
      );
      assert.equal(key.status, 201);
      await api(
        a.url,
        "POST",
        "/jobs",
        { type: "x", payload: {} },
        { authorization: `Bearer ${key.body.secret}` },
      );
      const { browser, reply } = await signup("Acme", "new@example.com");
      assert.notEqual(
        reply.body.account.slug,
        "acme",
        "the existing account cannot be claimed by name",
      );
      assert.deepEqual((await browser.get("/app/jobs")).body.items, []);
      assert.deepEqual((await browser.get("/app/keys")).body.items, []);
    });

    it("sign-up can be switched off for an invitation-only deployment", async () => {
      const closed = await startApi(
        db,
        {},
        { ...PORTAL_AUTH, portal: { ...PORTAL_AUTH.portal!, publicSignup: false } },
      );
      try {
        const r = await new Browser(closed.url).post("/app/auth/signup", {
          orgName: "X",
          name: "N",
          email: "a@example.com",
          password: PASSWORD,
        });
        assert.equal(r.status, 403);
        assert.equal(r.body.error.code, "signup_disabled");
      } finally {
        await stopApi(closed.server);
      }
    });

    it("login: wrong password, unknown email and a malformed request all look the same", async () => {
      await signup("Acme", "a@example.com");
      const wrong = await new Browser(a.url).post("/app/auth/login", {
        email: "a@example.com",
        password: "not the password",
      });
      const unknown = await new Browser(a.url).post("/app/auth/login", {
        email: "nobody@example.com",
        password: PASSWORD,
      });
      assert.equal(wrong.status, 401);
      assert.equal(unknown.status, 401);
      assert.equal(
        wrong.body.error.message,
        unknown.body.error.message,
        "no hint about which emails exist",
      );
      assert.equal(wrong.body.error.code, "invalid_credentials");
      assert.equal(wrong.headers.get("set-cookie"), null, "no cookie on failure");
      const ok = await new Browser(a.url).post("/app/auth/login", {
        email: " A@Example.com ",
        password: PASSWORD,
      });
      assert.equal(ok.status, 200, "email is case- and space-insensitive");
    });

    it("five wrong passwords lock the account; the right password does not help until the lock ends", async () => {
      await signup("Acme", "a@example.com");
      const attacker = new Browser(a.url);
      for (let i = 0; i < 5; i++) {
        assert.equal(
          (
            await attacker.post("/app/auth/login", {
              email: "a@example.com",
              password: `wrong-${i}-wrong`,
            })
          ).status,
          401,
        );
      }
      const during = await new Browser(a.url).post("/app/auth/login", {
        email: "a@example.com",
        password: PASSWORD,
      });
      assert.equal(during.status, 401, "locked: even the correct password is refused");
      assert.equal(
        during.body.error.message,
        (
          await attacker.post("/app/auth/login", {
            email: "a@example.com",
            password: "nope-nope-nope",
          })
        ).body.error.message,
      );
      await db.query("UPDATE users SET locked_until = now() - interval '1 second'");
      assert.equal(
        (
          await new Browser(a.url).post("/app/auth/login", {
            email: "a@example.com",
            password: PASSWORD,
          })
        ).status,
        200,
      );
    });

    it("a successful login resets the failure count", async () => {
      await signup("Acme", "a@example.com");
      const t = new Browser(a.url);
      for (let i = 0; i < 4; i++)
        await t.post("/app/auth/login", { email: "a@example.com", password: `wrong-${i}-wrong` });
      assert.equal(
        (await t.post("/app/auth/login", { email: "a@example.com", password: PASSWORD })).status,
        200,
      );
      for (let i = 0; i < 4; i++)
        await t.post("/app/auth/login", { email: "a@example.com", password: `wrong-${i}-wrong` });
      assert.equal(
        (await t.post("/app/auth/login", { email: "a@example.com", password: PASSWORD })).status,
        200,
        "4 + success + 4 never reaches 5 in a row",
      );
    });

    it("logout ends the session on the server, not just in the browser", async () => {
      const { browser } = await signup("Acme", "a@example.com");
      const stolen = new Browser(a.url);
      stolen.cookie = browser.cookie;
      assert.equal((await browser.post("/app/auth/logout")).status, 200);
      assert.equal(
        (await stolen.get("/app/auth/me")).status,
        401,
        "a copy of the cookie is dead too",
      );
    });

    it("expired and revoked sessions are refused", async () => {
      const { browser } = await signup("Acme", "a@example.com");
      await db.query("UPDATE sessions SET expires_at = now() - interval '1 second'");
      assert.equal((await browser.get("/app/auth/me")).status, 401);
    });

    it("changing the password ends the user's OTHER sessions", async () => {
      const { browser: first } = await signup("Acme", "a@example.com");
      const second = new Browser(a.url);
      await second.post("/app/auth/login", { email: "a@example.com", password: PASSWORD });
      const wrong = await first.post("/app/auth/change-password", {
        currentPassword: "not it at all",
        newPassword: "a brand new passphrase",
      });
      assert.equal(wrong.status, 400);
      const weak = await first.post("/app/auth/change-password", {
        currentPassword: PASSWORD,
        newPassword: "short",
      });
      assert.equal(weak.status, 400);
      const ok = await first.post("/app/auth/change-password", {
        currentPassword: PASSWORD,
        newPassword: "a brand new passphrase",
      });
      assert.equal(ok.status, 200);
      assert.equal((await first.get("/app/auth/me")).status, 200, "this session continues");
      assert.equal((await second.get("/app/auth/me")).status, 401, "the other one is ended");
      assert.equal(
        (
          await new Browser(a.url).post("/app/auth/login", {
            email: "a@example.com",
            password: PASSWORD,
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await new Browser(a.url).post("/app/auth/login", {
            email: "a@example.com",
            password: "a brand new passphrase",
          })
        ).status,
        200,
      );
    });
  });

  // ================================================================== CSRF
  describe("cross-site request forgery", () => {
    it("a state-changing request without the app's header is refused, even with a valid cookie", async () => {
      const { browser } = await signup("Acme", "a@example.com");
      const r = await browser.call("POST", "/app/jobs", { type: "x", payload: {} }, {}, false);
      assert.equal(r.status, 403);
      assert.equal(r.body.error.code, "csrf");
    });

    it("a request from another origin, or marked cross-site by the browser, is refused", async () => {
      const { browser } = await signup("Acme", "a@example.com");
      const origin = await browser.call(
        "POST",
        "/app/jobs",
        { type: "x", payload: {} },
        { origin: "https://evil.example" },
      );
      assert.equal(origin.status, 403);
      const site = await browser.call(
        "POST",
        "/app/jobs",
        { type: "x", payload: {} },
        { "sec-fetch-site": "cross-site" },
      );
      assert.equal(site.status, 403);
      const same = await browser.call(
        "POST",
        "/app/jobs",
        { type: "x", payload: {} },
        { origin: a.url, "sec-fetch-site": "same-origin" },
      );
      assert.equal(same.status, 201, "the real app's request goes through");
    });

    it("login and sign-up are protected too (login CSRF)", async () => {
      const r = await new Browser(a.url).call(
        "POST",
        "/app/auth/login",
        { email: "a@example.com", password: PASSWORD },
        {},
        false,
      );
      assert.equal(r.status, 403);
    });

    it("reads do not need the header", async () => {
      const { browser } = await signup("Acme", "a@example.com");
      assert.equal((await browser.call("GET", "/app/jobs", undefined, {}, false)).status, 200);
    });
  });

  // =================================================== roles: admin and viewer
  describe("roles", () => {
    const ROUTES: Array<{
      method: "GET" | "POST" | "PATCH" | "DELETE";
      path: string;
      who: "public" | "member" | "admin";
      example: string;
      body?: object;
    }> = [
      { method: "POST", path: "/auth/signup", who: "public", example: "/app/auth/signup" },
      { method: "POST", path: "/auth/login", who: "public", example: "/app/auth/login" },
      { method: "POST", path: "/auth/logout", who: "public", example: "/app/auth/logout" },
      {
        method: "POST",
        path: "/auth/invite-info",
        who: "public",
        example: "/app/auth/invite-info",
      },
      {
        method: "POST",
        path: "/auth/accept-invite",
        who: "public",
        example: "/app/auth/accept-invite",
      },
      { method: "GET", path: "/auth/session", who: "public", example: "/app/auth/session" },
      { method: "GET", path: "/auth/me", who: "member", example: "/app/auth/me" },
      {
        method: "POST",
        path: "/auth/change-password",
        who: "member",
        example: "/app/auth/change-password",
      },
      { method: "GET", path: "/overview", who: "member", example: "/app/overview" },
      { method: "GET", path: "/workers", who: "member", example: "/app/workers" },
      { method: "GET", path: "/jobs", who: "member", example: "/app/jobs" },
      { method: "GET", path: "/jobs/:id", who: "member", example: `/app/jobs/${ghostId}` },
      {
        method: "GET",
        path: "/jobs/:id/attempts",
        who: "member",
        example: `/app/jobs/${ghostId}/attempts`,
      },
      { method: "GET", path: "/workflows", who: "member", example: "/app/workflows" },
      {
        method: "GET",
        path: "/workflows/:id",
        who: "member",
        example: `/app/workflows/${ghostId}`,
      },
      { method: "GET", path: "/schedules", who: "member", example: "/app/schedules" },
      {
        method: "GET",
        path: "/schedules/:id",
        who: "member",
        example: `/app/schedules/${ghostId}`,
      },
      { method: "GET", path: "/keys", who: "member", example: "/app/keys" },
      { method: "GET", path: "/members", who: "member", example: "/app/members" },
      { method: "POST", path: "/jobs", who: "admin", example: "/app/jobs" },
      {
        method: "POST",
        path: "/jobs/:id/cancel",
        who: "admin",
        example: `/app/jobs/${ghostId}/cancel`,
      },
      {
        method: "POST",
        path: "/jobs/:id/retry",
        who: "admin",
        example: `/app/jobs/${ghostId}/retry`,
      },
      {
        method: "POST",
        path: "/workflows/:id/cancel",
        who: "admin",
        example: `/app/workflows/${ghostId}/cancel`,
      },
      { method: "POST", path: "/schedules", who: "admin", example: "/app/schedules" },
      {
        method: "PATCH",
        path: "/schedules/:id",
        who: "admin",
        example: `/app/schedules/${ghostId}`,
      },
      {
        method: "DELETE",
        path: "/schedules/:id",
        who: "admin",
        example: `/app/schedules/${ghostId}`,
      },
      { method: "POST", path: "/keys", who: "admin", example: "/app/keys" },
      {
        method: "POST",
        path: "/keys/:id/revoke",
        who: "admin",
        example: `/app/keys/${ghostId}/revoke`,
      },
      { method: "GET", path: "/invites", who: "admin", example: "/app/invites" },
      { method: "POST", path: "/invites", who: "admin", example: "/app/invites" },
      {
        method: "POST",
        path: "/invites/:id/revoke",
        who: "admin",
        example: `/app/invites/${ghostId}/revoke`,
      },
      { method: "PATCH", path: "/members/:id", who: "admin", example: `/app/members/${ghostId}` },
      { method: "DELETE", path: "/members/:id", who: "admin", example: `/app/members/${ghostId}` },
      { method: "GET", path: "/audit", who: "admin", example: "/app/audit" },
    ];

    it("GUARD: every route on the customer router is in the table above", () => {
      const router: any = portalRoutes({
        options: {
          sessionTtlHours: 1,
          cookieSecure: false,
          publicSignup: true,
          cost: { N: 1024, r: 8, p: 1 },
        },
        store: {},
      } as any);
      const found: string[] = [];
      for (const layer of router.stack) {
        if (!layer.route) continue;
        for (const m of Object.keys(layer.route.methods))
          found.push(`${m.toUpperCase()} ${layer.route.path}`);
      }
      assert.deepEqual(
        found.sort(),
        ROUTES.map((r) => `${r.method} ${r.path}`).sort(),
        "a route was added or removed without updating this table",
      );
    });

    it("nobody signed in: 401 on every route that needs a session", async () => {
      for (const r of ROUTES.filter((x) => x.who !== "public")) {
        const res = await new Browser(a.url).call(
          r.method,
          r.example,
          r.method === "GET" ? undefined : {},
        );
        assert.equal(res.status, 401, `${r.method} ${r.example}`);
      }
    });

    it("a viewer can read but is refused (403) on every admin route", async () => {
      const { browser: admin } = await signup("Acme", "admin@example.com");
      const viewer = await addMember(admin, "viewer@example.com", "viewer");
      assert.equal((await viewer.get("/app/auth/me")).body.user.role, "viewer");
      for (const r of ROUTES.filter((x) => x.who === "admin")) {
        const res = await viewer.call(r.method, r.example, r.method === "GET" ? undefined : {});
        assert.equal(res.status, 403, `${r.method} ${r.example}`);
        assert.equal(res.body.error.code, "forbidden");
      }
      for (const r of ROUTES.filter((x) => x.who === "member" && x.method === "GET")) {
        const res = await viewer.get(r.example);
        assert.ok(res.status !== 401 && res.status !== 403, `${r.example} -> ${res.status}`);
      }
    });

    it("an admin is never refused for authorization reasons", async () => {
      const { browser: admin } = await signup("Acme", "admin@example.com");
      for (const r of ROUTES.filter((x) => x.who === "admin")) {
        const res = await admin.call(r.method, r.example, r.method === "GET" ? undefined : {});
        assert.ok(
          res.status !== 401 && res.status !== 403,
          `${r.method} ${r.example} -> ${res.status}`,
        );
      }
    });

    it("a viewer's changes really did not happen (not just a status code)", async () => {
      const { browser: admin } = await signup("Acme", "admin@example.com");
      const job = await admin.post("/app/jobs", { type: "x.y", payload: {} });
      const viewer = await addMember(admin, "viewer@example.com", "viewer");
      await viewer.post(`/app/jobs/${job.body.id}/cancel`);
      await viewer.post("/app/jobs", { type: "x.y", payload: {} });
      await viewer.post("/app/keys", { kind: "client", name: "sneaky" });
      assert.equal((await admin.get(`/app/jobs/${job.body.id}`)).body.status, "queued");
      assert.equal((await admin.get("/app/jobs")).body.items.length, 1);
      assert.equal((await admin.get("/app/keys")).body.items.length, 0);
    });
  });

  // ================================================================ invitations
  describe("team members and invitations", () => {
    it("an admin invites someone: the link token is shown once, and the invitee joins with the chosen role", async () => {
      const { browser: admin } = await signup("Acme", "admin@example.com");
      const invite = await admin.post("/app/invites", { email: "New@Example.com", role: "viewer" });
      assert.equal(invite.status, 201);
      assert.ok(invite.body.token.length >= 40, "the token is returned once");
      const listed = await admin.get("/app/invites");
      assert.ok(
        !JSON.stringify(listed.body).includes(invite.body.token),
        "and never listed afterwards",
      );
      assert.equal(listed.body.items[0].status, "open");
      const stored = (await db.query("SELECT token_hash FROM invites")).rows[0];
      assert.equal(stored.token_hash.length, 32);

      const info = await new Browser(a.url).post("/app/auth/invite-info", {
        token: invite.body.token,
      });
      assert.deepEqual(info.body, {
        email: "new@example.com",
        role: "viewer",
        accountName: "Acme",
      });

      const member = new Browser(a.url);
      const accepted = await member.post("/app/auth/accept-invite", {
        token: invite.body.token,
        name: "Pat",
        password: PASSWORD,
      });
      assert.equal(accepted.status, 201);
      assert.equal(accepted.body.user.role, "viewer");
      assert.equal(accepted.body.account.slug, "acme");
      assert.equal((await member.get("/app/auth/me")).status, 200, "signed in on acceptance");
    });

    it("an invitation works once, and not after it expires or is revoked", async () => {
      const { browser: admin } = await signup("Acme", "admin@example.com");
      const one = await admin.post("/app/invites", { email: "one@example.com", role: "viewer" });
      assert.equal(
        (
          await new Browser(a.url).post("/app/auth/accept-invite", {
            token: one.body.token,
            name: "P",
            password: PASSWORD,
          })
        ).status,
        201,
      );
      const again = await new Browser(a.url).post("/app/auth/accept-invite", {
        token: one.body.token,
        name: "P",
        password: PASSWORD,
      });
      assert.equal(again.status, 400, "used up");
      assert.equal(
        (await new Browser(a.url).post("/app/auth/invite-info", { token: one.body.token })).status,
        404,
      );

      const two = await admin.post("/app/invites", { email: "two@example.com", role: "viewer" });
      await db.query(
        "UPDATE invites SET expires_at = now() - interval '1 second' WHERE email = 'two@example.com'",
      );
      assert.equal(
        (
          await new Browser(a.url).post("/app/auth/accept-invite", {
            token: two.body.token,
            name: "P",
            password: PASSWORD,
          })
        ).status,
        400,
        "expired",
      );
      const renewed = await admin.post("/app/invites", {
        email: "two@example.com",
        role: "viewer",
      });
      assert.equal(renewed.status, 201, "an expired invitation does not block a new one");

      const three = await admin.post("/app/invites", {
        email: "three@example.com",
        role: "viewer",
      });
      assert.equal((await admin.post(`/app/invites/${three.body.id}/revoke`)).status, 200);
      assert.equal(
        (
          await new Browser(a.url).post("/app/auth/accept-invite", {
            token: three.body.token,
            name: "P",
            password: PASSWORD,
          })
        ).status,
        400,
        "revoked",
      );
    });

    it("the store itself refuses an expired invitation (the route's own check is not the only one)", async () => {
      const { browser: admin } = await signup("Acme", "admin@example.com");
      const invite = await admin.post("/app/invites", {
        email: "late@example.com",
        role: "viewer",
      });
      await db.query("UPDATE invites SET expires_at = now() - interval '1 second'");
      const store = new PortalStore(db, { sessionTtlHours: 1, cost: { N: 1024, r: 8, p: 1 } });
      await assert.rejects(
        store.acceptInvite(invite.body.token, "Late", PASSWORD),
        (e: any) => e.code === "invalid_invite",
      );
      assert.equal(
        (await db.query("SELECT count(*)::int AS n FROM users WHERE email = 'late@example.com'"))
          .rows[0].n,
        0,
      );
    });

    it("duplicate or pointless invitations are refused", async () => {
      const { browser: admin } = await signup("Acme", "admin@example.com");
      assert.equal(
        (await admin.post("/app/invites", { email: "x@example.com", role: "viewer" })).status,
        201,
      );
      assert.equal(
        (await admin.post("/app/invites", { email: "X@example.com", role: "admin" })).status,
        409,
        "already one open",
      );
      assert.equal(
        (await admin.post("/app/invites", { email: "admin@example.com", role: "viewer" })).status,
        409,
        "already has an account",
      );
      assert.equal(
        (await admin.post("/app/invites", { email: "bad", role: "viewer" })).status,
        400,
      );
      assert.equal(
        (await admin.post("/app/invites", { email: "y@example.com", role: "owner" })).status,
        400,
      );
    });

    it("the weak-password rule applies to invitees too", async () => {
      const { browser: admin } = await signup("Acme", "admin@example.com");
      const invite = await admin.post("/app/invites", {
        email: "weak@example.com",
        role: "viewer",
      });
      const r = await new Browser(a.url).post("/app/auth/accept-invite", {
        token: invite.body.token,
        name: "P",
        password: "short",
      });
      assert.equal(r.status, 400);
      assert.equal(
        (await new Browser(a.url).post("/app/auth/invite-info", { token: invite.body.token }))
          .status,
        200,
        "the invitation is still usable",
      );
    });

    it("an organisation can never lose its last admin", async () => {
      const { browser: admin, reply } = await signup("Acme", "admin@example.com");
      const id = reply.body.user.id;
      assert.equal((await admin.patch(`/app/members/${id}`, { role: "viewer" })).status, 409);
      assert.equal((await admin.del(`/app/members/${id}`)).status, 409);
      assert.equal((await admin.get("/app/members")).body.items[0].role, "admin");
      const second = await addMember(admin, "second@example.com", "admin");
      const secondId = (await second.get("/app/auth/me")).body.user.id;
      assert.equal(
        (await admin.patch(`/app/members/${secondId}`, { role: "viewer" })).status,
        200,
        "fine while another admin remains",
      );
    });

    it("two admins demoting each other over HTTP never leave the organisation without an admin", async () => {
      const { browser: first, reply } = await signup("Acme", "one@example.com");
      const second = await addMember(first, "two@example.com", "admin");
      const firstId = reply.body.user.id;
      const secondId = (await second.get("/app/auth/me")).body.user.id;
      const results = await Promise.all([
        first.patch(`/app/members/${secondId}`, { role: "viewer" }),
        second.patch(`/app/members/${firstId}`, { role: "viewer" }),
      ]);
      // Depending on timing the loser is refused as "no longer an admin" (403: its session already
      // sees the demotion) or by the last-admin rule (409: both got inside). Both are correct.
      const statuses = results.map((r) => r.status);
      assert.equal(
        statuses.filter((s) => s === 200).length,
        1,
        `exactly one succeeds: ${statuses}`,
      );
      assert.ok(
        statuses.every((s) => [200, 403, 409].includes(s)),
        `unexpected: ${statuses}`,
      );
      assert.equal(
        (await db.query("SELECT count(*)::int AS n FROM users WHERE role = 'admin'")).rows[0].n,
        1,
      );
    });

    it("the last-admin check waits for the admin rows to be locked (the row lock is what makes it race-free)", async () => {
      const { browser: first, reply } = await signup("Acme", "one@example.com");
      const second = await addMember(first, "two@example.com", "admin");
      const firstId = reply.body.user.id;
      const secondId = (await second.get("/app/auth/me")).body.user.id;
      const store = new PortalStore(db, { sessionTtlHours: 1, cost: { N: 1024, r: 8, p: 1 } });

      // Another transaction is in the middle of changing the admins: it holds their rows locked.
      const holder = await db.connect();
      await holder.query("BEGIN");
      await holder.query(
        "SELECT id FROM users WHERE account = 'acme' AND role = 'admin' FOR UPDATE",
      );

      let settled = false;
      const pending = store
        .changeRole("acme", secondId, "viewer")
        .then(
          () => ({ ok: true as const }),
          (error: { code?: string }) => ({ ok: false as const, code: error.code }),
        )
        .finally(() => {
          settled = true;
        });
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(settled, false, "the demotion must WAIT while the admin rows are locked");

      // The other transaction demotes the first admin and commits, leaving `second` the last admin.
      await holder.query("UPDATE users SET role = 'viewer' WHERE id = $1", [firstId]);
      await holder.query("COMMIT");
      holder.release();

      // Only now does the waiting demotion run. It must see ONE admin and refuse.
      assert.deepEqual(await pending, { ok: false, code: "last_admin" });
      assert.equal(
        (await db.query("SELECT count(*)::int AS n FROM users WHERE role = 'admin'")).rows[0].n,
        1,
      );
    });

    it("removing a member ends their sessions at once", async () => {
      const { browser: admin } = await signup("Acme", "admin@example.com");
      const member = await addMember(admin, "gone@example.com", "viewer");
      const id = (await member.get("/app/auth/me")).body.user.id;
      assert.equal((await admin.del(`/app/members/${id}`)).status, 204);
      assert.equal((await member.get("/app/auth/me")).status, 401);
      assert.equal(
        (
          await new Browser(a.url).post("/app/auth/login", {
            email: "gone@example.com",
            password: PASSWORD,
          })
        ).status,
        401,
      );
    });

    it("members of one organisation cannot see or change another's", async () => {
      const { browser: adminA } = await signup("Alpha", "a@example.com");
      const { browser: adminB, reply: replyB } = await signup("Beta", "b@example.com");
      const idB = replyB.body.user.id;
      assert.equal((await adminA.get("/app/members")).body.items.length, 1);
      assert.equal((await adminA.patch(`/app/members/${idB}`, { role: "viewer" })).status, 404);
      assert.equal((await adminA.del(`/app/members/${idB}`)).status, 404);
      const invite = await adminB.post("/app/invites", { email: "x@example.com", role: "viewer" });
      assert.equal((await adminA.post(`/app/invites/${invite.body.id}/revoke`)).status, 404);
      assert.equal((await adminA.get("/app/invites")).body.items.length, 0);
    });
  });

  // ============================================================== isolation
  describe("organisations are isolated from each other", () => {
    it("jobs, workflows, schedules, keys, workers and audit are invisible across organisations", async () => {
      const { browser: alpha } = await signup("Alpha", "a@example.com");
      const { browser: beta } = await signup("Beta", "b@example.com");

      const job = (
        await alpha.post("/app/jobs", { type: "alpha.job", payload: { secret: "alpha-only" } })
      ).body;
      const schedule = (
        await alpha.post("/app/schedules", {
          name: "nightly",
          cron: "0 3 * * *",
          jobType: "alpha.job",
          payload: {},
        })
      ).body;
      const key = (await alpha.post("/app/keys", { kind: "worker", name: "alpha worker" })).body;
      assert.ok(job.id && schedule.id && key.id);
      const wf = await api(
        a.url,
        "POST",
        "/workflows",
        { name: "w", nodes: [{ key: "n", type: "alpha.job", payload: {}, dependsOn: [] }] },
        {
          authorization: `Bearer ${(await alpha.post("/app/keys", { kind: "client", name: "c" })).body.secret}`,
        },
      );
      assert.equal(wf.status, 201);
      await api(
        a.url,
        "POST",
        "/workers",
        { name: "w", jobTypes: ["alpha.job"], concurrency: 1 },
        { authorization: `Bearer ${key.secret}` },
      );

      assert.deepEqual((await beta.get("/app/jobs")).body.items, []);
      assert.deepEqual((await beta.get("/app/workflows")).body.items, []);
      assert.deepEqual((await beta.get("/app/schedules")).body.items, []);
      assert.deepEqual((await beta.get("/app/keys")).body.items, []);
      assert.deepEqual((await beta.get("/app/workers")).body.items, []);
      assert.deepEqual(
        (await beta.get("/app/audit")).body.items
          .map((e: any) => e.targetId)
          .filter((id: string) => [job.id, schedule.id, key.id].includes(id)),
        [],
      );
      for (const path of [
        `/app/jobs/${job.id}`,
        `/app/jobs/${job.id}/attempts`,
        `/app/workflows/${wf.body.id}`,
        `/app/schedules/${schedule.id}`,
      ]) {
        assert.equal((await beta.get(path)).status, 404, path);
      }
      assert.equal((await beta.post(`/app/jobs/${job.id}/cancel`)).status, 404);
      assert.equal((await beta.post(`/app/jobs/${job.id}/retry`, {})).status, 404);
      assert.equal((await beta.post(`/app/workflows/${wf.body.id}/cancel`)).status, 404);
      assert.equal(
        (await beta.patch(`/app/schedules/${schedule.id}`, { enabled: false })).status,
        404,
      );
      assert.equal((await beta.del(`/app/schedules/${schedule.id}`)).status, 404);
      assert.equal((await beta.post(`/app/keys/${key.id}/revoke`)).status, 404);
      assert.equal(
        (await alpha.get(`/app/jobs/${job.id}`)).body.status,
        "queued",
        "untouched by Beta's attempts",
      );
      assert.equal((await alpha.get(`/app/schedules/${schedule.id}`)).body.enabled, true);
      assert.equal(
        (await alpha.get("/app/keys")).body.items.find((k: any) => k.id === key.id).status,
        "active",
      );
    });

    it("the overview numbers count only the signed-in organisation's jobs", async () => {
      const { browser: alpha } = await signup("Alpha", "a@example.com");
      const { browser: beta } = await signup("Beta", "b@example.com");
      for (let i = 0; i < 3; i++) await alpha.post("/app/jobs", { type: "t.a", payload: {} });
      await beta.post("/app/jobs", { type: "t.b", payload: {} });
      const a1 = (await alpha.get("/app/overview")).body;
      const b1 = (await beta.get("/app/overview")).body;
      assert.equal(a1.queue.ready, 3);
      assert.equal(b1.queue.ready, 1);
      const worker = await alpha.post("/app/keys", { kind: "worker", name: "w" });
      const reg = await api(
        a.url,
        "POST",
        "/workers",
        { name: "w", jobTypes: ["t.a"], concurrency: 5 },
        { authorization: `Bearer ${worker.body.secret}` },
      );
      assert.equal(reg.status, 201);
      assert.equal((await alpha.get("/app/overview")).body.workers.alive, 1);
      assert.equal((await beta.get("/app/overview")).body.workers.alive, 0);
      assert.equal((await alpha.get("/app/workers")).body.items.length, 1);
    });

    it("the organisation always comes from the session: a request cannot name one", async () => {
      const { browser: alpha } = await signup("Alpha", "a@example.com");
      const r = await alpha.post("/app/jobs", {
        type: "x.y",
        payload: {},
        account: "someone-else",
      });
      assert.equal(r.status, 400);
      const key = await alpha.post("/app/keys", {
        kind: "client",
        name: "k",
        account: "someone-else",
      });
      assert.equal(key.status, 400);
      const ok = await alpha.post("/app/keys", { kind: "client", name: "k" });
      assert.equal(ok.body.account, "alpha");
    });

    it("jobs submitted in the app belong to the organisation: the machine plane sees them, other keys do not", async () => {
      const { browser: alpha } = await signup("Alpha", "a@example.com");
      const { browser: beta } = await signup("Beta", "b@example.com");
      const job = (await alpha.post("/app/jobs", { type: "x.y", payload: {} })).body;
      assert.equal(job.account, "alpha");
      const alphaKey = (await alpha.post("/app/keys", { kind: "client", name: "k" })).body.secret;
      const betaKey = (await beta.post("/app/keys", { kind: "client", name: "k" })).body.secret;
      assert.equal(
        (
          await api(a.url, "GET", `/jobs/${job.id}`, undefined, {
            authorization: `Bearer ${alphaKey}`,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await api(a.url, "GET", `/jobs/${job.id}`, undefined, {
            authorization: `Bearer ${betaKey}`,
          })
        ).status,
        404,
      );
    });

    it("keys made in the app work on the machine plane for that organisation only, and the secret is shown once", async () => {
      const { browser: alpha } = await signup("Alpha", "a@example.com");
      const created = await alpha.post("/app/keys", {
        kind: "client",
        name: "billing",
        expiresInDays: 30,
      });
      assert.equal(created.status, 201);
      assert.match(created.body.secret, /^wm_[a-f0-9]{8}_/);
      assert.ok(created.body.expiresAt);
      const listed = JSON.stringify((await alpha.get("/app/keys")).body);
      assert.ok(!listed.includes(created.body.secret), "never listed with its secret");
      assert.equal(
        (
          await api(
            a.url,
            "POST",
            "/jobs",
            { type: "x.y", payload: {} },
            { authorization: `Bearer ${created.body.secret}` },
          )
        ).body.account,
        "alpha",
      );
      assert.equal((await alpha.post(`/app/keys/${created.body.id}/revoke`)).status, 200);
      assert.equal(
        (
          await api(a.url, "GET", "/jobs", undefined, {
            authorization: `Bearer ${created.body.secret}`,
          })
        ).status,
        401,
        "revoked at once",
      );
    });

    it("schedules can be created, paused and deleted by an admin, and are audited in the organisation", async () => {
      const { browser: admin } = await signup("Alpha", "a@example.com");
      const created = await admin.post("/app/schedules", {
        name: "nightly",
        cron: "0 3 * * *",
        jobType: "report.build",
        payload: {},
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.account, "alpha");
      assert.equal(
        (
          await admin.post("/app/schedules", {
            name: "nightly",
            cron: "0 3 * * *",
            jobType: "report.build",
            payload: {},
          })
        ).status,
        409,
      );
      assert.equal(
        (await admin.patch(`/app/schedules/${created.body.id}`, { enabled: false })).body.enabled,
        false,
      );
      assert.equal((await admin.del(`/app/schedules/${created.body.id}`)).status, 204);
      const entries = (await admin.get("/app/audit")).body.items.filter((e: any) =>
        e.action.startsWith("schedule."),
      );
      assert.deepEqual(entries.map((e: any) => e.action).sort(), [
        "schedule.create",
        "schedule.delete",
        "schedule.disable",
      ]);
      assert.ok(entries.every((e: any) => e.actor === "user:a@example.com" && e.role === "admin"));
    });

    it("the audit log is per organisation, names the user, and is admin-only", async () => {
      const { browser: alpha } = await signup("Alpha", "a@example.com");
      const { browser: beta } = await signup("Beta", "b@example.com");
      const viewer = await addMember(alpha, "v@example.com", "viewer");
      await alpha.post("/app/jobs", { type: "x.y", payload: {} });
      await beta.post("/app/jobs", { type: "x.y", payload: {} });
      const log = (await alpha.get("/app/audit")).body.items;
      assert.ok(log.length >= 3);
      assert.ok(
        log.every((e: any) => e.actor.startsWith("user:") && ["admin", "viewer"].includes(e.role)),
      );
      assert.ok(
        log.some((e: any) => e.actor === "user:a@example.com" && e.action === "job.submit"),
      );
      assert.ok(
        !log.some((e: any) => e.actor === "user:b@example.com"),
        "Beta's actions are not in Alpha's log",
      );
      assert.equal((await viewer.get("/app/audit")).status, 403);
    });
  });

  // ========================================================= secrets and logs
  describe("secrets", () => {
    it("neither passwords nor session tokens reach the logs, while failures stay diagnosable", async () => {
      const SECRET_PASSWORD = "very-secret-passphrase-1";
      const { text } = await captureLogs(async () => {
        const { browser } = await signup("Acme", "a@example.com", SECRET_PASSWORD);
        const token = decodeURIComponent(browser.cookie.split("=")[1]!);
        const login = new Browser(a.url);
        await login.post("/app/auth/login", {
          email: "a@example.com",
          password: "wrong-wrong-wrong-1",
        });
        await login.post("/app/auth/login", { email: "a@example.com", password: SECRET_PASSWORD });
        await browser.post("/app/auth/change-password", {
          currentPassword: SECRET_PASSWORD,
          newPassword: "another-secret-passphrase-2",
        });
        const invite = await browser.post("/app/invites", {
          email: "i@example.com",
          role: "viewer",
        });
        await browser.post("/app/keys", { kind: "client", name: "k" });
        (globalThis as any).__t = { token, invite: invite.body.token };
      });
      const { token, invite } = (globalThis as any).__t;
      for (const [label, value] of [
        ["password", SECRET_PASSWORD],
        ["wrong password", "wrong-wrong-wrong-1"],
        ["new password", "another-secret-passphrase-2"],
        ["session token", token],
        ["invite token", invite],
      ] as const) {
        assert.ok(!text.includes(value), `the logs contain the ${label}`);
      }
      assert.match(text, /"login_failed"/);
      assert.match(text, /"reason":"wrong_password"/);
    });

    it("the audit log never contains passwords or tokens", async () => {
      const { browser } = await signup("Acme", "a@example.com");
      const invite = await browser.post("/app/invites", { email: "i@example.com", role: "viewer" });
      const text = JSON.stringify((await browser.get("/app/audit")).body);
      assert.ok(!text.includes(PASSWORD) && !text.includes(invite.body.token));
    });
  });
});
