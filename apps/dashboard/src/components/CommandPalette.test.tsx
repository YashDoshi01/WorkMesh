import { fireEvent, screen } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { fakeApi, renderAs } from "../test-utils";
import { CommandPalette } from "./CommandPalette";
import { ToastProvider, useToast } from "./Toast";

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

describe("the command menu", () => {
  it("filters as you type and opens the chosen page with Enter, then closes", () => {
    const onClose = vi.fn();
    renderAs(
      "admin",
      fakeApi(),
      <>
        <CommandPalette open onClose={onClose} />
        <Routes>
          <Route path="*" element={<Where />} />
        </Routes>
      </>,
    );
    const input = screen.getByRole("combobox", { name: /search pages and actions/i });
    fireEvent.change(input, { target: { value: "key" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("where").textContent).toBe("/keys");
    expect(onClose).toHaveBeenCalled();
  });

  it("offers admin-only actions to admins and hides them from viewers", () => {
    const { unmount } = renderAs("admin", fakeApi(), <CommandPalette open onClose={() => {}} />);
    expect(screen.getByRole("option", { name: /submit a job/i })).toBeTruthy();
    expect(screen.getByRole("option", { name: /audit log/i })).toBeTruthy();
    unmount();
    renderAs("viewer", fakeApi(), <CommandPalette open onClose={() => {}} />);
    expect(screen.queryByRole("option", { name: /submit a job/i })).toBeNull();
    expect(screen.queryByRole("option", { name: /audit log/i })).toBeNull();
  });

  it("says so when nothing matches, and Escape closes it", () => {
    const onClose = vi.fn();
    renderAs("admin", fakeApi(), <CommandPalette open onClose={onClose} />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "zzzz" } });
    expect(screen.getByText(/nothing matches/i)).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("renders nothing while closed", () => {
    renderAs("admin", fakeApi(), <CommandPalette open={false} onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("toasts", () => {
  function Button() {
    const toast = useToast();
    return (
      <button type="button" onClick={() => toast.show("Saved it")}>
        go
      </button>
    );
  }
  it("announces a message and can be dismissed", () => {
    renderAs(
      "admin",
      fakeApi(),
      <ToastProvider>
        <Button />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("go"));
    expect(screen.getByRole("status").textContent).toContain("Saved it");
    fireEvent.click(screen.getByRole("button", { name: /dismiss notification/i }));
    expect(screen.queryByText("Saved it")).toBeNull();
  });

  it("does nothing, and does not crash, outside a provider", () => {
    renderAs("admin", fakeApi(), <Button />);
    fireEvent.click(screen.getByText("go"));
    expect(screen.queryByText("Saved it")).toBeNull();
  });
});
