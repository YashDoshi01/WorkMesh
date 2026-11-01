import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { vi } from "vitest";
import type { ApiClient } from "./api/client";
import { ApiError } from "./api/client";
import type { Attempt, Job, Role, Stats, WorkflowDetail } from "./api/schemas";
import { SessionContext, type Session } from "./auth/auth";

/** A fake API: every method is a vi.fn(); a test overrides the ones it cares about. */
export type FakeApi = { [K in keyof ApiClient]: ReturnType<typeof vi.fn> };

export function fakeApi(overrides: Partial<FakeApi> = {}): FakeApi {
  const never = () => new Promise(() => undefined);
  return {
    session: vi.fn(never),
    signup: vi.fn(never),
    login: vi.fn(never),
    logout: vi.fn(never),
    inviteInfo: vi.fn(never),
    acceptInvite: vi.fn(never),
    changePassword: vi.fn(never),
    keys: vi.fn(never),
    createKey: vi.fn(never),
    revokeKey: vi.fn(never),
    members: vi.fn(never),
    invites: vi.fn(never),
    createInvite: vi.fn(never),
    revokeInvite: vi.fn(never),
    changeRole: vi.fn(never),
    removeMember: vi.fn(never),
    createSchedule: vi.fn(never),
    stats: vi.fn(never),
    workers: vi.fn(never),
    audit: vi.fn(never),
    jobs: vi.fn(never),
    job: vi.fn(never),
    attempts: vi.fn(never),
    submitJob: vi.fn(never),
    cancelJob: vi.fn(never),
    retryJob: vi.fn(never),
    workflows: vi.fn(never),
    workflow: vi.fn(never),
    cancelWorkflow: vi.fn(never),
    schedules: vi.fn(never),
    setScheduleEnabled: vi.fn(never),
    deleteSchedule: vi.fn(never),
    ...overrides,
  } as FakeApi;
}

/** Renders `ui` inside a router and a signed-in session. */
export function renderAs(
  role: Role,
  api: FakeApi,
  ui: ReactElement,
  options: { path?: string; route?: string } = {},
) {
  const session: Session = {
    me: {
      user: {
        id: "99999999-9999-4999-8999-999999999999",
        email: `${role}@example.com`,
        name: "Test User",
        role,
        createdAt: "2026-01-01T10:00:00.000Z",
        lastLoginAt: null,
      },
      account: { slug: "acme", name: "Acme" },
    },
    api: api as unknown as ApiClient,
    signIn: vi.fn(),
    signUp: vi.fn(),
    acceptInvite: vi.fn(),
    signOut: vi.fn(),
    canOperate: role === "admin",
  };
  return {
    session,
    ...render(
      <SessionContext.Provider value={session}>
        <MemoryRouter initialEntries={[options.route ?? "/"]}>
          <Routes>
            <Route path={options.path ?? "*"} element={ui} />
          </Routes>
        </MemoryRouter>
      </SessionContext.Provider>,
    ),
  };
}

export const apiError = (status: number, code: string, message: string, details = []) =>
  new ApiError(status, code, message, details);

export function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    type: "email.send",
    payload: { to: "a@b.c" },
    status: "queued",
    priority: 0,
    runAt: "2026-01-01T10:00:00.000Z",
    scheduledFor: "2026-01-01T10:00:00.000Z",
    scheduleId: null,
    workflowId: null,
    attemptCount: 0,
    maxAttempts: 3,
    leaseExpiresAt: null,
    claimedBy: null,
    startedAt: null,
    finishedAt: null,
    lastError: null,
    createdAt: "2026-01-01T10:00:00.000Z",
    updatedAt: "2026-01-01T10:00:00.000Z",
    ...overrides,
  };
}

export function attempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    attemptNumber: 1,
    workerId: "22222222-2222-4222-8222-222222222222",
    outcome: "failed",
    error: "boom",
    startedAt: "2026-01-01T10:00:00.000Z",
    finishedAt: "2026-01-01T10:00:02.000Z",
    ...overrides,
  };
}

export function stats(overrides: Partial<Stats> = {}): Stats {
  return {
    generatedAt: "2026-01-01T12:00:00.000Z",
    windowMinutes: 60,
    bucketMinutes: 1,
    queue: { queued: 5, ready: 3, scheduled: 2, running: 1, oldestReadyAgeSeconds: 600 },
    window: {
      succeeded: 4,
      failed: 1,
      cancelled: 0,
      retries: 2,
      leaseExpirations: 1,
      throughputPerMinute: 4 / 60,
      executionSeconds: { p50: 5, p95: 7.7, max: 8 },
      waitSeconds: { p50: 2, p95: 6.5, max: 7 },
    },
    series: [
      { start: "2026-01-01T11:57:00.000Z", succeeded: 1, failed: 0 },
      { start: "2026-01-01T11:58:00.000Z", succeeded: 3, failed: 1 },
      { start: "2026-01-01T11:59:00.000Z", succeeded: 0, failed: 0 },
    ],
    workers: { alive: 2, stale: 1 },
    ...overrides,
  };
}

export function workflowDetail(overrides: Partial<WorkflowDetail> = {}): WorkflowDetail {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    name: "nightly",
    status: "running",
    cancelRequested: false,
    createdAt: "2026-01-01T10:00:00.000Z",
    finishedAt: null,
    progress: {
      total: 2,
      waiting: 1,
      queued: 0,
      running: 1,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      skipped: 0,
    },
    nodes: [
      {
        key: "a",
        type: "t.a",
        state: "running",
        dependsOn: [],
        jobId: "44444444-4444-4444-8444-444444444444",
        attemptCount: 1,
        lastError: null,
      },
      {
        key: "b",
        type: "t.b",
        state: "waiting",
        dependsOn: ["a"],
        jobId: null,
        attemptCount: null,
        lastError: null,
      },
    ],
    ...overrides,
  };
}

/** A promise you resolve by hand, to control the order in which responses arrive. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
