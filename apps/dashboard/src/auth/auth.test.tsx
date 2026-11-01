import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { stats } from "../test-utils";
import { SessionProvider } from "./auth";

/**
 * These tests drive the real SessionProvider, ApiClient and App against a fake `fetch` that
 * behaves like the customer API: it keeps ONE session (standing in for the cookie), checks
 * credentials, and answers 401 to anything that needs a session when there is none.
 */
type Role = "admin" | "viewer";
const USERS: Record<string, { password: string; name: string; role: Role }> = {
  "ada@example.com": { password: "correct horse battery", name: "Ada Admin", role: "admin" },
  "vic@example.com": { password: "another long passphrase", name: "Vic Viewer", role: "viewer" },
};

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const identityOf = (email: string, name: string, role: Role) => ({
  user: {
    id: `user-${email}`,
    email,
    name,
    role,
    createdAt: "2026-01-01T10:00:00.000Z",
    lastLoginAt: null,
  },
  account: { slug: "acme", name: "Acme Corp" },
});

let session: ReturnType<typeof identityOf> | null = null;
let ended = false; // the server ends the session mid-use
const calls: { method: string; url: string; csrf: string | undefined }[] = [];

function fakeServer(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method, url, csrf: headers["x-workmesh-csrf"] });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    if (url === "/app/auth/login") {
      const u = USERS[String(body.email)];
      if (!u || u.password !== body.password) {
        return json(401, {
          error: { code: "invalid_credentials", message: "Invalid email or password" },
        });
      }
      session = identityOf(body.email, u.name, u.role);
      return json(200, session);
    }
    if (url === "/app/auth/signup") {
      if (String(body.password).length < 10) {
        return json(400, {
          error: {
            code: "validation_error",
            message: "Invalid sign-up",
            details: [{ path: "password", message: "must be at least 10 characters" }],
          },
        });
      }
      session = identityOf(body.email, body.name, "admin");
      session.account = { slug: "newco", name: body.orgName };
      return json(201, session);
    }
    if (url === "/app/auth/logout") {
      session = null;
      return json(200, { ok: true });
    }
    if (url === "/app/auth/session") return json(200, { me: ended ? null : session });
    if (!session || ended) {
      return json(401, { error: { code: "unauthenticated", message: "Please sign in" } });
    }
    if (url.startsWith("/app/overview")) {
      return json(
        200,
        session.account.slug === "newco"
          ? stats({
              queue: { queued: 0, ready: 0, scheduled: 0, running: 0, oldestReadyAgeSeconds: null },
              window: {
                succeeded: 0,
                failed: 0,
                cancelled: 0,
                retries: 0,
                leaseExpirations: 0,
                throughputPerMinute: 0,
                executionSeconds: null,
                waitSeconds: null,
              },
              series: [],
              workers: { alive: 0, stale: 0 },
            })
          : stats(),
      );
    }
    if (url.startsWith("/app/jobs")) return json(200, { items: [], nextCursor: null });
    return json(404, { error: { code: "not_found", message: "no route" } });
  }) as typeof fetch;
}

function mount(path = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider>
        <App />
      </SessionProvider>
    </MemoryRouter>,
  );
}

async function fillAndSubmitLogin(email: string, password: string) {
  fireEvent.change(await screen.findByLabelText("Email"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

beforeEach(() => {
  session = null;
  ended = false;
  calls.length = 0;
  vi.stubGlobal("fetch", fakeServer());
});
afterEach(() => vi.unstubAllGlobals());

describe("the public pages", () => {
  it("a visitor sees the landing page, not the app", async () => {
    mount();
    expect(await screen.findByRole("heading", { level: 1, name: /always get done/i })).toBeTruthy();
    expect(
      screen.getAllByRole("link", { name: /create account|get started/i }).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
  });

  it("the only call before anyone signs in is the check for an existing session", async () => {
    mount();
    await screen.findByRole("heading", { level: 1 });
    expect(calls.map((c) => c.url)).toEqual(["/app/auth/session"]);
  });

  it("a deep link opened while signed out goes to sign-in, and returns there afterwards", async () => {
    mount("/jobs");
    await fillAndSubmitLogin("ada@example.com", USERS["ada@example.com"]!.password);
    expect(await screen.findByRole("heading", { level: 1, name: "Jobs" })).toBeTruthy();
  });
});

describe("signing in", () => {
  it("a wrong password is refused with the server's message, and nothing opens", async () => {
    mount("/login");
    await fillAndSubmitLogin("ada@example.com", "not the password");
    expect((await screen.findByRole("alert")).textContent).toMatch(/Invalid email or password/);
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
  });

  it("an admin signs in and sees the full app", async () => {
    mount("/login");
    await fillAndSubmitLogin("ada@example.com", USERS["ada@example.com"]!.password);
    expect(await screen.findByRole("navigation", { name: "Main" })).toBeTruthy();
    expect(screen.getByText("Acme Corp")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Submit a job/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Audit log" })).toBeTruthy();
    expect(screen.queryByText(/read-only access/)).toBeNull();
  });

  it("a viewer signs in read-only: no submit button, no audit log, and the app says so", async () => {
    mount("/login");
    await fillAndSubmitLogin("vic@example.com", USERS["vic@example.com"]!.password);
    expect(await screen.findByRole("navigation", { name: "Main" })).toBeTruthy();
    expect(screen.getByRole("note").textContent).toMatch(/read-only/);
    expect(screen.queryByRole("link", { name: /Submit a job/ })).toBeNull();
    expect(screen.queryByRole("link", { name: "Audit log" })).toBeNull();
  });

  it("the sign-in request is a POST with the CSRF header, and no credential is stored in the page", async () => {
    mount("/login");
    await fillAndSubmitLogin("ada@example.com", USERS["ada@example.com"]!.password);
    await screen.findByRole("navigation", { name: "Main" });
    const login = calls.find((c) => c.url === "/app/auth/login")!;
    expect([login.method, login.csrf]).toEqual(["POST", "1"]);
    expect(JSON.stringify({ ...localStorage })).not.toMatch(/correct horse|session|token/i);
    expect(JSON.stringify({ ...sessionStorage })).not.toMatch(/correct horse|session|token/i);
  });

  it("a network failure says the service is unreachable, not 'wrong password'", async () => {
    mount("/login");
    await screen.findByLabelText("Email");
    vi.stubGlobal("fetch", (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch);
    await fillAndSubmitLogin("ada@example.com", "whatever password");
    expect((await screen.findByRole("alert")).textContent).toMatch(/Cannot reach the service/);
  });
});

describe("creating an account", () => {
  it("sign-up opens the app as the new organisation's admin", async () => {
    mount("/signup");
    fireEvent.change(await screen.findByLabelText("Organisation name"), {
      target: { value: "NewCo" },
    });
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Nia" } });
    fireEvent.change(screen.getByLabelText("Work email"), { target: { value: "nia@newco.test" } });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "a long enough passphrase" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("navigation", { name: "Main" })).toBeTruthy();
    expect(screen.getByText("NewCo")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Get started" })).toBeTruthy();
  });

  it("the server's password complaint appears next to the password field", async () => {
    mount("/signup");
    fireEvent.change(await screen.findByLabelText("Organisation name"), {
      target: { value: "NewCo" },
    });
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Nia" } });
    fireEvent.change(screen.getByLabelText("Work email"), { target: { value: "nia@newco.test" } });
    // Long enough for the browser's own check, short enough for the fake server to refuse.
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "0123456789" } });
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === "/app/auth/signup"
        ? json(400, {
            error: {
              code: "validation_error",
              message: "Invalid sign-up",
              details: [{ path: "password", message: "is too common" }],
            },
          })
        : original(input, init)) as typeof fetch);
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect((await screen.findByText("is too common")).getAttribute("role")).toBe("alert");
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
  });
});

describe("staying signed in, and signing out", () => {
  it("a reload with a valid session restores it without asking again", async () => {
    session = identityOf("ada@example.com", "Ada Admin", "admin");
    mount("/");
    expect(await screen.findByRole("navigation", { name: "Main" })).toBeTruthy();
    expect(calls.some((c) => c.url === "/app/auth/login")).toBe(false);
  });

  it("signing out calls the server and returns to the public pages", async () => {
    session = identityOf("ada@example.com", "Ada Admin", "admin");
    mount("/");
    fireEvent.click(await screen.findByRole("button", { name: /Account menu for/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Sign out/ }));
    expect(await screen.findByRole("heading", { level: 1, name: /always get done/i })).toBeTruthy();
    expect(calls.some((c) => c.url === "/app/auth/logout" && c.method === "POST")).toBe(true);
    expect(session).toBeNull();
  });

  it("if the server ends the session mid-use, the next request sends the user back to sign in", async () => {
    session = identityOf("ada@example.com", "Ada Admin", "admin");
    mount("/");
    await screen.findByRole("navigation", { name: "Main" });
    ended = true;
    fireEvent.click(screen.getByRole("link", { name: "Jobs" }));
    await waitFor(() => expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull());
    expect(await screen.findByLabelText("Email")).toBeTruthy();
  });
});
