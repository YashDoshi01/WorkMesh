import { describe, expect, it } from "vitest";
import {
  formatAgo,
  formatClock,
  formatCount,
  formatDateTime,
  formatDuration,
  formatRate,
  niceMax,
  shortId,
} from "./format";

describe("formatDuration", () => {
  it.each([
    [0, "0 ms"],
    [0.42, "420 ms"],
    [3.14, "3.1 s"],
    [10, "10 s"],
    [59.4, "59 s"],
    [125, "2m 5s"],
    [3600, "1h 0m"],
    [7260, "2h 1m"],
  ])("%s seconds -> %s", (seconds, text) => {
    expect(formatDuration(seconds)).toBe(text);
  });

  it("shows a dash for nonsense instead of NaN", () => {
    expect(formatDuration(Number.NaN)).toBe("–");
    expect(formatDuration(-5)).toBe("–");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("–");
  });
});

describe("formatAgo", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  it.each([
    ["2026-01-01T11:59:59Z", "just now"],
    ["2026-01-01T11:59:18Z", "42s ago"],
    ["2026-01-01T11:55:00Z", "5m ago"],
    ["2026-01-01T09:00:00Z", "3h ago"],
    ["2025-12-30T12:00:00Z", "2d ago"],
    ["2026-01-01T12:05:00Z", "in 5m 0s"],
  ])("%s -> %s", (iso, text) => {
    expect(formatAgo(new Date(iso), now)).toBe(text);
  });
});

describe("dates", () => {
  it("renders a missing or invalid date as a dash", () => {
    expect(formatDateTime(null)).toBe("–");
    expect(formatDateTime(undefined)).toBe("–");
    expect(formatDateTime("not a date")).toBe("–");
    expect(formatClock("not a date")).toBe("–");
  });

  it("honours an explicit time zone (a schedule's own zone)", () => {
    // 09:00 in New York on 2026-01-15 is 14:00 UTC
    expect(formatClock("2026-01-15T14:00:00Z", "America/New_York")).toMatch(/09:00/);
    expect(formatClock("2026-01-15T14:00:00Z", "UTC")).toMatch(/02:00|14:00/);
  });
});

describe("numbers", () => {
  it("groups digits the way the viewer's own locale does (1,234,567 or 12,34,567 ...)", () => {
    expect(formatCount(1234567)).toBe(new Intl.NumberFormat().format(1234567));
    expect(formatCount(1234567).replace(/\D/g, "")).toBe("1234567");
    expect(formatCount(1234567).length).toBeGreaterThan("1234567".length);
  });

  it.each([
    [0, "0"],
    [0.0667, "0.07"],
    [12.5, "12.5"],
    [250.4, "250"],
  ])("rate %s -> %s", (n, text) => {
    expect(formatRate(n)).toBe(text);
  });

  it("shortId keeps the first 8 characters", () => {
    expect(shortId("12345678-aaaa-bbbb-cccc-dddddddddddd")).toBe("12345678");
  });
});

describe("niceMax (chart axis)", () => {
  it.each([
    [0, 1],
    [1, 1],
    [3, 3],
    [5, 5],
    [6, 10],
    [11, 20],
    [34, 50],
    [51, 100],
    [999, 1000],
    [1001, 2000],
  ])("%s -> %s", (value, expected) => {
    expect(niceMax(value)).toBe(expected);
  });

  it("never returns less than the value", () => {
    for (let v = 0; v < 5000; v += 7) expect(niceMax(v)).toBeGreaterThanOrEqual(v);
  });
});
