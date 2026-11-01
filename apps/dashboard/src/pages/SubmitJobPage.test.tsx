import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { apiError, fakeApi, job, renderAs } from "../test-utils";
import { SubmitJobPage, buildJobRequest } from "./SubmitJobPage";

const fields = {
  type: "email.send",
  payload: '{"to":"a@b.c"}',
  priority: "0",
  maxAttempts: "3",
  runAt: "",
};

describe("buildJobRequest (client-side convenience; the server still decides)", () => {
  it("builds a request from valid fields", () => {
    expect(buildJobRequest(fields)).toEqual({
      ok: true,
      request: { type: "email.send", payload: { to: "a@b.c" }, priority: 0, maxAttempts: 3 },
    });
  });

  it("treats an empty payload as {}", () => {
    const r = buildJobRequest({ ...fields, payload: "  " });
    expect(r.ok && r.request.payload).toEqual({});
  });

  it("converts the local run-at into an ISO timestamp", () => {
    const r = buildJobRequest({ ...fields, runAt: "2030-01-01T09:30" });
    expect(r.ok && r.request.runAt).toBe(new Date("2030-01-01T09:30").toISOString());
  });

  it.each([
    ["a bad type", { type: "Email Send" }, /Type must be/],
    ["an empty type", { type: "" }, /Type must be/],
    ["invalid JSON", { payload: "{nope" }, /not valid JSON/],
    ["an array payload", { payload: "[1,2]" }, /must be a JSON object/],
    ["a null payload", { payload: "null" }, /must be a JSON object/],
    ["a string payload", { payload: '"x"' }, /must be a JSON object/],
    [
      "a huge payload",
      { payload: JSON.stringify({ blob: "a".repeat(70_000) }) },
      /larger than 64 KiB/,
    ],
    ["priority 101", { priority: "101" }, /Priority must be/],
    ["a fractional priority", { priority: "1.5" }, /Priority must be/],
    ["zero attempts", { maxAttempts: "0" }, /Attempts must be/],
    ["21 attempts", { maxAttempts: "21" }, /Attempts must be/],
    ["a bad date", { runAt: "tomorrow-ish" }, /Run-at is not a valid/],
  ])("rejects %s", (_name, change, message) => {
    const r = buildJobRequest({ ...fields, ...change });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join(" ")).toMatch(message);
  });

  it("reports every problem at once, not just the first", () => {
    const r = buildJobRequest({
      type: "BAD",
      payload: "{",
      priority: "500",
      maxAttempts: "0",
      runAt: "",
    });
    expect(!r.ok && r.problems.length).toBe(4);
  });
});

describe("SubmitJobPage", () => {
  const type = (value: string) =>
    fireEvent.change(screen.getByLabelText("Job type"), { target: { value } });
  const payload = (value: string) =>
    fireEvent.change(screen.getByLabelText(/Payload/), { target: { value } });
  const submit = () => fireEvent.click(screen.getByRole("button", { name: "Submit job" }));

  it("submits the request and links to the new job", async () => {
    const submitJob = vi.fn(async () => job({ id: "99999999-9999-4999-8999-999999999999" }));
    renderAs("operator", fakeApi({ submitJob }), <SubmitJobPage />);
    type("email.send");
    payload('{"to":"a@b.c"}');
    submit();
    await waitFor(() => expect(submitJob).toHaveBeenCalledTimes(1));
    expect(submitJob).toHaveBeenCalledWith({
      type: "email.send",
      payload: { to: "a@b.c" },
      priority: 0,
      maxAttempts: 3,
    });
    const link = await screen.findByRole("link", { name: /View job 99999999/ });
    expect(link.getAttribute("href")).toBe("/jobs/99999999-9999-4999-8999-999999999999");
  });

  it("does not call the API at all when the input is obviously wrong", () => {
    const submitJob = vi.fn();
    renderAs("operator", fakeApi({ submitJob }), <SubmitJobPage />);
    type("email.send");
    payload("{broken");
    submit();
    expect(submitJob).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/not valid JSON/);
  });

  it("shows the server's field-level validation errors", async () => {
    const submitJob = vi.fn(async () => {
      throw apiError(400, "validation_error", "Invalid job", [
        { path: "payload", message: "must serialize to at most 65536 bytes" },
      ] as never);
    });
    renderAs("operator", fakeApi({ submitJob }), <SubmitJobPage />);
    type("email.send");
    submit();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Invalid job/);
    expect(alert.textContent).toMatch(/payload: must serialize/);
  });

  it("a viewer cannot submit: the button is disabled and the page says why", () => {
    const submitJob = vi.fn();
    renderAs("viewer", fakeApi({ submitJob }), <SubmitJobPage />);
    expect((screen.getByRole("button", { name: "Submit job" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByRole("note").textContent).toMatch(/Viewers cannot submit/);
  });

  it("a 403 from the server (role changed since sign-in) is shown, not swallowed", async () => {
    const submitJob = vi.fn(async () => {
      throw apiError(403, "forbidden", "This action needs the 'operator' role (you have 'viewer')");
    });
    renderAs("operator", fakeApi({ submitJob }), <SubmitJobPage />);
    type("email.send");
    submit();
    expect((await screen.findByRole("alert")).textContent).toMatch(/needs the 'operator' role/);
  });
});
