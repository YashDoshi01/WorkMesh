import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { apiError, fakeApi, renderAs, stats } from "../test-utils";
import { OverviewPage } from "./OverviewPage";

const tile = (label: string): HTMLElement => {
  const dt = screen.getByText(label, { selector: "dt" });
  return dt.parentElement as HTMLElement;
};

describe("OverviewPage shows real numbers from the API", () => {
  it("renders each figure exactly as the server reported it", async () => {
    renderAs("viewer", fakeApi({ stats: vi.fn(async () => stats()) }), <OverviewPage />);
    await screen.findByText("Right now");

    expect(within(tile("Ready to run")).getByText("3")).toBeTruthy();
    expect(within(tile("Scheduled for later")).getByText("2")).toBeTruthy();
    expect(within(tile("Running")).getByText("1")).toBeTruthy();
    expect(within(tile("Longest wait")).getByText("10m 0s")).toBeTruthy(); // 600 s
    expect(within(tile("Workers")).getByText("2 alive")).toBeTruthy();
    expect(within(tile("Workers")).getByText("1 not responding")).toBeTruthy();

    expect(within(tile("Succeeded")).getByText("4")).toBeTruthy();
    expect(within(tile("Failed")).getByText("1")).toBeTruthy();
    expect(within(tile("Retries")).getByText("2")).toBeTruthy();
    expect(within(tile("Lost leases")).getByText("1")).toBeTruthy();
    expect(within(tile("Throughput")).getByText("0.07 /min")).toBeTruthy(); // 4 / 60
  });

  it("renders the timing percentiles", async () => {
    renderAs("viewer", fakeApi({ stats: vi.fn(async () => stats()) }), <OverviewPage />);
    const running = (await screen.findByText(/Running time/, { selector: "dt" })).parentElement!;
    expect(within(running).getByText("5.0 s")).toBeTruthy(); // p50
    expect(within(running).getByText("7.7 s")).toBeTruthy(); // p95
    expect(within(running).getByText("8.0 s")).toBeTruthy(); // max
    const wait = screen.getByText(/Wait before starting/, { selector: "dt" }).parentElement!;
    expect(within(wait).getByText("2.0 s")).toBeTruthy();
  });

  it("draws the chart from the series it was given", async () => {
    const { container } = renderAs(
      "viewer",
      fakeApi({ stats: vi.fn(async () => stats()) }),
      <OverviewPage />,
    );
    await screen.findByText("Jobs finished");
    expect(container.querySelectorAll(".column")).toHaveLength(3);
    expect(container.querySelector(".peak-label")?.textContent).toBe("4");
  });

  it("an idle system says so plainly instead of drawing an empty chart or inventing numbers", async () => {
    const idle = stats({
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
      workers: { alive: 0, stale: 0 },
    });
    const { container } = renderAs(
      "viewer",
      fakeApi({ stats: vi.fn(async () => idle) }),
      <OverviewPage />,
    );
    expect(await screen.findByText(/No jobs finished in the last 1 hour/)).toBeTruthy();
    expect(container.querySelector(".chart")).toBeNull();
    expect(within(tile("Longest wait")).getByText("–")).toBeTruthy();
    expect(screen.getAllByText("Nothing measured in this window.")).toHaveLength(2);
  });

  it("asks for a different window when the filter changes, and the numbers follow", async () => {
    const statsFn = vi.fn(async (minutes: number) =>
      stats({ windowMinutes: minutes, window: { ...stats().window, succeeded: minutes } }),
    );
    renderAs("viewer", fakeApi({ stats: statsFn }), <OverviewPage />);
    await waitFor(() => expect(within(tile("Succeeded")).getByText("60")).toBeTruthy());
    expect(statsFn.mock.calls[0]?.[0]).toBe(60);

    fireEvent.click(screen.getByRole("button", { name: "4 hours" }));
    await waitFor(() => expect(within(tile("Succeeded")).getByText("240")).toBeTruthy());
    expect(statsFn.mock.calls.some(([m]) => m === 240)).toBe(true);
    expect(screen.getByRole("button", { name: "4 hours" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "1 hour" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("shows a loading state first", () => {
    renderAs("viewer", fakeApi(), <OverviewPage />);
    expect(screen.getByRole("status").textContent).toMatch(/Loading statistics/);
  });

  it("shows an error with a retry button when the API fails, and recovers when it comes back", async () => {
    let healthy = false;
    const statsFn = vi.fn(async () => {
      if (!healthy)
        throw apiError(
          0,
          "network",
          "Cannot reach the API. Check that it is running and try again.",
        );
      return stats();
    });
    renderAs("viewer", fakeApi({ stats: statsFn }), <OverviewPage />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Could not load statistics/);
    expect(alert.textContent).toMatch(/Cannot reach the API/);

    healthy = true;
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Right now")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
