import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { stats } from "../test-utils";
import { SessionProvider } from "./auth";
import { keyStore } from "./keyStore";

/**
 * These tests drive the real SessionProvider, ApiClient and App against a fake `fetch` that
 * behaves like the operator plane: it knows two keys, checks them, and 401s anything else.
 */
const OPERATOR = "operator-key-0123456789";
const VIEWER = "viewer-key-abcdefghij";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let revoked = false;
const calls: { url: string; auth: string | undefined }[] = [];

function fakeServer(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    calls.push({ url, auth });
    const role =
      auth === `Bearer ${OPERATOR}` ? "operator" : auth === `Bearer ${VIEWER}` ? "viewer" : null;
    if (!role || revoked) {
      return json(401, { error: { code: "unauthenticated", message: "Invalid API key" } });
    }
    if (url === "/ops/me") return json(200, { role, actor: `${role}:abcd1234` });
    if (url.startsWith("/ops/stats")) return json(200, stats());
    return json(404, { error: { code: "not_found", message: "no route" } });
  }) as typeof fetch;
}

function mount() {
  return render(
    <MemoryRouter>
      <SessionProvider>
        <App />
      </SessionProvider>
    </MemoryRouter>,
  );
}

async function signIn(key: string) {
  fireEvent.change(await screen.findByLabelText("API key"), { target: { value: key } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

beforeEach(() => {
  revoked = false;
  calls.length = 0;
  vi.stubGlobal("fetch", fakeServer());
});
afterEach(() => {
  vi.unstubAllGlobals();
  keyStore.set(null);
});

describe("signing in", () => {
  it("shows the sign-in form first, and nothing else", async () => {
    mount();
    expect(await screen.findByLabelText("API key")).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("a wrong key is refused with a clear message and is NOT remembered", async () => {
    mount();
    await signIn("not-a-real-key-000000");
    expect((await screen.findByRole("alert")).textContent).toMatch(/not accepted/);
    expect(keyStore.get()).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("the operator key signs in, shows the app and the role, and keeps the key in sessionStorage only", async () => {
    mount();
    await signIn(OPERATOR);
    expect(await screen.findByRole("navigation", { name: "Main" })).toBeTruthy();
    expect(screen.getByText("operator")).toBeTruthy();
    expect(screen.queryByText(/read-only/)).toBeNull();
    expect(sessionStorage.getItem("workmesh.apiKey")).toBe(OPERATOR);
    expect(localStorage.getItem("workmesh.apiKey")).toBeNull();
  });

  it("the viewer key signs in read-only and the app says so", async () => {
    mount();
    await signIn(VIEWER);
    expect(await screen.findByRole("navigation", { name: "Main" })).toBeTruthy();
    expect(screen.getByRole("note").textContent).toMatch(/read-only/);
  });

  it("every request after sign-in carries the key", async () => {
    mount();
    await signIn(OPERATOR);
    await screen.findByRole("navigation", { name: "Main" });
    await waitFor(() => expect(calls.some((c) => c.url.startsWith("/ops/stats"))).toBe(true));
    for (const c of calls.filter((c) => c.url.startsWith("/ops/stats"))) {
      expect(c.auth).toBe(`Bearer ${OPERATOR}`);
    }
  });

  it("a network failure while signing in says the API is unreachable, not 'wrong key'", async () => {
    vi.stubGlobal("fetch", (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch);
    mount();
    await signIn(OPERATOR);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Cannot reach the API/);
  });
});

describe("staying signed in, and signing out", () => {
  it("signing out forgets the key and returns to the form", async () => {
    mount();
    await signIn(OPERATOR);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByLabelText("API key")).toBeTruthy();
    expect(keyStore.get()).toBeNull();
  });

  it("a reload with a still-valid key restores the session without asking again", async () => {
    keyStore.set(OPERATOR);
    mount();
    expect(await screen.findByRole("navigation", { name: "Main" })).toBeTruthy();
  });

  it("a stored key the server no longer accepts is discarded", async () => {
    keyStore.set("stale-key-that-was-rotated");
    mount();
    expect(await screen.findByLabelText("API key")).toBeTruthy();
    expect(keyStore.get()).toBeNull();
  });

  it("if the server revokes the key mid-session, the very next request sends the user back to sign in", async () => {
    mount();
    await signIn(OPERATOR);
    await screen.findByRole("navigation", { name: "Main" });
    revoked = true;
    fireEvent.click(screen.getByRole("link", { name: "Jobs" }));
    expect(await screen.findByLabelText("API key")).toBeTruthy();
    expect(keyStore.get()).toBeNull();
  });
});
