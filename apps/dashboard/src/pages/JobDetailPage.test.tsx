import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { JobDetailPage, jobActions } from "./JobDetailPage";
import { apiError, attempt, fakeApi, job, renderAs } from "../test-utils";

const route = "/jobs/11111111-1111-4111-8111-111111111111";
const page = <JobDetailPage />;
const mount = (role: "admin" | "viewer", j = job(), overrides = {}) => {
  const api = fakeApi({
    job: vi.fn(async () => j),
    attempts: vi.fn(async () => [attempt()]),
    ...overrides,
  });
  return { api, ...renderAs(role, api, page, { path: "/jobs/:id", route }) };
};

describe("what the page offers (jobActions)", () => {
  it.each([
    ["admin", { status: "queued" }, { cancel: true, retry: false }],
    ["admin", { status: "failed" }, { cancel: false, retry: true }],
    ["admin", { status: "running" }, { cancel: false, retry: false }],
    ["admin", { status: "succeeded" }, { cancel: false, retry: false }],
    ["admin", { status: "cancelled" }, { cancel: false, retry: false }],
    ["admin", { status: "queued", workflowId: "w1" }, { cancel: false, retry: false }],
    ["admin", { status: "failed", workflowId: "w1" }, { cancel: false, retry: false }],
    ["viewer", { status: "queued" }, { cancel: false, retry: false }],
    ["viewer", { status: "failed" }, { cancel: false, retry: false }],
  ] as const)("%s, job %j -> %j", (role, overrides, expected) => {
    const a = jobActions(job(overrides as never), role === "admin");
    expect({ cancel: a.cancel, retry: a.retry }).toEqual(expected);
  });
});

describe("JobDetailPage", () => {
  it("shows the job's facts, error and attempt history from the API", async () => {
    mount(
      "admin",
      job({ status: "failed", attemptCount: 1, maxAttempts: 1, lastError: "provider said no" }),
    );
    expect(await screen.findByText("provider said no")).toBeTruthy();
    expect(screen.getByText("1 of 1")).toBeTruthy();
    const table = await screen.findByRole("table");
    expect(within(table).getByText("boom")).toBeTruthy();
    expect(within(table).getByText(/failed/)).toBeTruthy();
  });

  it("an operator can cancel a queued job, after confirming", async () => {
    const cancelJob = vi.fn(async () => job({ status: "cancelled" }));
    const { api } = mount("admin", job({ status: "queued" }), { cancelJob });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel job" }));
    expect(cancelJob).not.toHaveBeenCalled(); // the first click only arms it
    fireEvent.click(screen.getByRole("button", { name: "Yes, cancel it" }));
    await waitFor(() =>
      expect(cancelJob).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111"),
    );
    expect((await screen.findByRole("status")).textContent).toMatch(/Job cancelled/);
    await waitFor(() => expect(api.job.mock.calls.length).toBeGreaterThan(1)); // reloaded afterwards
  });

  it("when the SERVER refuses (the job started meanwhile), the page shows the server's own explanation", async () => {
    const refusal = apiError(
      409,
      "job_not_cancellable",
      "The job is running; only queued jobs can be cancelled (a running job cannot be stopped safely)",
    );
    const cancelJob = vi.fn(async () => {
      throw refusal;
    });
    mount("admin", job({ status: "queued" }), { cancelJob });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel job" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, cancel it" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/The job is running/);
    expect(alert.textContent).toMatch(/cannot be stopped safely/);
  });

  it("an operator can retry a failed job with a chosen number of extra attempts", async () => {
    const retryJob = vi.fn(async () => job({ status: "queued" }));
    mount("admin", job({ status: "failed", attemptCount: 1, maxAttempts: 1 }), { retryJob });
    const input = await screen.findByLabelText("Extra attempts");
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Retry job" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, retry with 3 more" }));
    await waitFor(() =>
      expect(retryJob).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", 3),
    );
  });

  it("a viewer sees NO action buttons, only an explanation", async () => {
    mount("viewer", job({ status: "queued" }));
    await screen.findByText("email.send");
    expect(screen.queryByRole("button", { name: /cancel|retry/i })).toBeNull();
    expect(screen.getByText(/read-only access/)).toBeTruthy();
  });

  it("explains why a running job has no cancel button", async () => {
    mount("admin", job({ status: "running", attemptCount: 1 }));
    await screen.findByText("email.send");
    expect(screen.queryByRole("button", { name: "Cancel job" })).toBeNull();
    expect(screen.getByText(/cannot be stopped safely/)).toBeTruthy();
  });

  it("a workflow job points to its workflow instead of offering actions", async () => {
    mount("admin", job({ status: "queued", workflowId: "33333333-3333-4333-8333-333333333333" }));
    await screen.findByText("email.send");
    expect(screen.queryByRole("button", { name: "Cancel job" })).toBeNull();
    expect(screen.getByText(/part of a workflow/)).toBeTruthy();
    expect(
      (screen.getByRole("link", { name: "33333333" }) as HTMLAnchorElement).getAttribute("href"),
    ).toBe("/workflows/33333333-3333-4333-8333-333333333333");
  });

  it("shows an error state, with a way to retry, when the job cannot be loaded", async () => {
    mount("admin", job(), {
      job: vi.fn(async () => {
        throw apiError(404, "job_not_found", "Job does not exist");
      }),
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Job does not exist/);
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("says plainly when no attempt has started", async () => {
    mount("admin", job(), { attempts: vi.fn(async () => []) });
    expect(await screen.findByText("No attempt has started yet.")).toBeTruthy();
  });
});
