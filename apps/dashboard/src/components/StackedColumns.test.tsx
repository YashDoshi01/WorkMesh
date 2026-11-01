import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StackedColumns, type Bucket } from "./StackedColumns";

const buckets: Bucket[] = [
  { start: "2026-01-01T11:57:00.000Z", succeeded: 1, failed: 0 },
  { start: "2026-01-01T11:58:00.000Z", succeeded: 3, failed: 1 },
  { start: "2026-01-01T11:59:00.000Z", succeeded: 0, failed: 0 },
  { start: "2026-01-01T12:00:00.000Z", succeeded: 0, failed: 2 },
];

describe("StackedColumns", () => {
  it("has a legend with an icon AND a word for both series (colour is never alone)", () => {
    render(<StackedColumns buckets={buckets} bucketMinutes={1} />);
    const legend = screen.getByRole("list", { name: "Legend" });
    expect(within(legend).getByText(/✓ Succeeded/)).toBeTruthy();
    expect(within(legend).getByText(/✕ Failed/)).toBeTruthy();
  });

  it("labels only the peak, not every bar", () => {
    const { container } = render(<StackedColumns buckets={buckets} bucketMinutes={1} />);
    const labels = container.querySelectorAll(".peak-label");
    expect(labels).toHaveLength(1);
    expect(labels[0]?.textContent).toBe("4"); // the 11:58 bucket: 3 + 1
  });

  it("draws only non-zero values, and caps bar width at 24", () => {
    const wide: Bucket[] = [{ start: "2026-01-01T12:00:00.000Z", succeeded: 5, failed: 0 }];
    const { container } = render(<StackedColumns buckets={wide} bucketMinutes={1} />);
    // one bucket gives it a 672-unit slot, but the bar stays slim
    const segments = container.querySelectorAll(".seg");
    expect(segments).toHaveLength(1);
    const path = segments[0]!.getAttribute("d") ?? "";
    const xs = [...path.matchAll(/[MHVQ]?(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
    expect(xs.length).toBeGreaterThan(0);
    // width = largest minus smallest x coordinate used by the path
    const horizontal = [...path.matchAll(/(?:M|H|Q)(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
    expect(Math.max(...horizontal) - Math.min(...horizontal)).toBeLessThanOrEqual(24.0001);
  });

  it("leaves a 2px gap between the stacked segments", () => {
    const { container } = render(
      <StackedColumns
        buckets={[{ start: "2026-01-01T12:00:00.000Z", succeeded: 5, failed: 5 }]}
        bucketMinutes={1}
      />,
    );
    const succeeded = container.querySelector("rect.seg-succeeded")!;
    const failedPath = container.querySelector("path.seg-failed")!.getAttribute("d")!;
    const succeededTop = Number(succeeded.getAttribute("y"));
    // the failed path ends (its bottom edge) at "V<bottom>Z"
    const bottom = Number(/V(-?\d+(?:\.\d+)?)Z$/.exec(failedPath)![1]);
    expect(succeededTop - bottom).toBeCloseTo(2, 5);
  });

  it("hovering a column shows the exact numbers, value first", () => {
    const { container } = render(<StackedColumns buckets={buckets} bucketMinutes={1} />);
    const tooltip = container.querySelector(".tooltip") as HTMLElement;
    expect(tooltip.hidden).toBe(true);
    fireEvent.mouseEnter(container.querySelectorAll(".hit")[1]!);
    expect(tooltip.hidden).toBe(false);
    expect(within(tooltip).getByText("3").tagName).toBe("STRONG");
    expect(tooltip.textContent).toMatch(/3\s*succeeded/);
    expect(tooltip.textContent).toMatch(/1\s*failed/);
    fireEvent.mouseLeave(container.querySelector(".chart-frame")!);
    expect(tooltip.hidden).toBe(true);
  });

  it("the keyboard reads the same data: arrow keys move between columns, Escape clears", () => {
    const { container } = render(<StackedColumns buckets={buckets} bucketMinutes={1} />);
    const frame = container.querySelector(".chart-frame") as HTMLElement;
    expect(frame.tabIndex).toBe(0);
    const tooltip = container.querySelector(".tooltip") as HTMLElement;

    fireEvent.keyDown(frame, { key: "End" });
    expect(tooltip.textContent).toMatch(/2\s*failed/);
    fireEvent.keyDown(frame, { key: "ArrowLeft" });
    expect(tooltip.textContent).toMatch(/0\s*succeeded/);
    fireEvent.keyDown(frame, { key: "Home" });
    expect(tooltip.textContent).toMatch(/1\s*succeeded/);
    fireEvent.keyDown(frame, { key: "Escape" });
    expect(tooltip.hidden).toBe(true);
  });

  it("has a table twin holding every value (tooltips never gate information)", () => {
    render(<StackedColumns buckets={buckets} bucketMinutes={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Show as table" }));
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(buckets.length + 1);
    const rows = within(table).getAllByRole("row").slice(1);
    const values = rows.map((r) =>
      within(r)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    );
    expect(values).toEqual([
      ["1", "0"],
      ["3", "1"],
      ["0", "0"],
      ["0", "2"],
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Show as chart" }));
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("dims (instead of blanking) while refreshing", () => {
    const { container } = render(<StackedColumns buckets={buckets} bucketMinutes={1} dimmed />);
    expect(container.querySelector(".chart-frame")?.className).toContain("is-refreshing");
  });

  it("copes with a single bucket and with all zeros", () => {
    const { container } = render(
      <StackedColumns
        buckets={[{ start: "2026-01-01T12:00:00.000Z", succeeded: 0, failed: 0 }]}
        bucketMinutes={1}
      />,
    );
    expect(container.querySelectorAll(".seg")).toHaveLength(0);
    expect(container.querySelectorAll(".peak-label")).toHaveLength(0);
  });

  it("opens scrolled to the newest data (the right edge) when the chart is wider than its box", () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get: () => 777,
    });
    try {
      const { container } = render(<StackedColumns buckets={buckets} bucketMinutes={1} />);
      expect((container.querySelector(".chart-frame") as HTMLElement).scrollLeft).toBe(777);
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "scrollWidth", original);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollWidth;
    }
  });

  it("positions the tooltip from the hovered column (the stylesheet clamps it inside the chart)", () => {
    const { container } = render(<StackedColumns buckets={buckets} bucketMinutes={1} />);
    const tooltip = container.querySelector(".tooltip") as HTMLElement;
    fireEvent.mouseEnter(container.querySelectorAll(".hit")[0]!);
    const first = parseFloat(tooltip.style.getPropertyValue("--x"));
    fireEvent.mouseEnter(container.querySelectorAll(".hit")[3]!);
    const last = parseFloat(tooltip.style.getPropertyValue("--x"));
    expect(first).toBeGreaterThan(0);
    expect(last).toBeGreaterThan(first); // a later column sits further right
    expect(last).toBeLessThan(100);
  });
});
