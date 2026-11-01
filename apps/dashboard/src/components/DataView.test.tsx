import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import type { Resource } from "../hooks/useResource";
import { ConfirmButton } from "./bits";
import { DataView } from "./DataView";

function resource<T>(overrides: Partial<Resource<T>>): Resource<T> {
  return {
    data: undefined,
    error: undefined,
    loading: false,
    refreshing: false,
    stale: false,
    updatedAt: undefined,
    reload: vi.fn(),
    ...overrides,
  };
}

describe("DataView: the four states", () => {
  it("LOADING: says so, and does not render the data", () => {
    render(
      <DataView resource={resource<string[]>({ loading: true })} what="jobs">
        {() => <p>content</p>}
      </DataView>,
    );
    expect(screen.getByRole("status").textContent).toMatch(/Loading jobs/);
    expect(screen.queryByText("content")).toBeNull();
  });

  it("ERROR with nothing to show: names the problem and offers to retry", () => {
    const reload = vi.fn();
    render(
      <DataView
        resource={resource<string[]>({
          error: new ApiError(500, "x", "Internal server error"),
          reload,
        })}
        what="jobs"
      >
        {() => <p>content</p>}
      </DataView>,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/Could not load jobs/);
    expect(alert.textContent).toMatch(/Internal server error/);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("EMPTY: a friendly message, not a blank table", () => {
    render(
      <DataView
        resource={resource<string[]>({ data: [] })}
        isEmpty={(d) => d.length === 0}
        empty="No jobs match these filters."
      >
        {() => <p>content</p>}
      </DataView>,
    );
    expect(screen.getByText("No jobs match these filters.")).toBeTruthy();
    expect(screen.queryByText("content")).toBeNull();
  });

  it("DATA: renders the children", () => {
    render(
      <DataView resource={resource<string[]>({ data: ["a", "b"] })} isEmpty={(d) => d.length === 0}>
        {(d) => <p>{d.join(",")}</p>}
      </DataView>,
    );
    expect(screen.getByText("a,b")).toBeTruthy();
  });

  it("STALE: keeps showing the data, says the refresh failed and when the data is from", () => {
    render(
      <DataView
        resource={resource<string[]>({
          data: ["old"],
          stale: true,
          error: new ApiError(0, "network", "Cannot reach the API."),
          updatedAt: new Date("2026-01-01T10:05:00Z"),
        })}
        what="jobs"
      >
        {(d) => <p>{d.join(",")}</p>}
      </DataView>,
    );
    expect(screen.getByText("old")).toBeTruthy();
    const note = screen.getByRole("status");
    expect(note.textContent).toMatch(/Could not refresh jobs/);
    expect(note.textContent).toMatch(/Cannot reach the API/);
    expect(note.textContent).toMatch(/Showing what was loaded/);
  });

  it("REFRESHING: previous content stays, marked busy (no layout jump, no skeleton)", () => {
    const { container } = render(
      <DataView resource={resource<string[]>({ data: ["x"], refreshing: true })}>
        {(d) => <p>{d.join(",")}</p>}
      </DataView>,
    );
    expect(screen.getByText("x")).toBeTruthy();
    const wrapper = container.querySelector(".data");
    expect(wrapper?.getAttribute("aria-busy")).toBe("true");
    expect(wrapper?.className).toContain("is-refreshing");
  });
});

describe("ConfirmButton", () => {
  it("needs a second click before doing anything", async () => {
    const onConfirm = vi.fn();
    render(<ConfirmButton label="Delete" confirmLabel="Yes, delete" onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Yes, delete" }));
    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  it("can be backed out of without doing anything", () => {
    const onConfirm = vi.fn();
    render(<ConfirmButton label="Delete" confirmLabel="Yes, delete" onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  });

  it("cannot be clicked when disabled", () => {
    render(<ConfirmButton label="Delete" confirmLabel="Yes" onConfirm={vi.fn()} disabled />);
    expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
