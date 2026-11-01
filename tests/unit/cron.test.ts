import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeScheduleProblem,
  latestOccurrenceAtOrBefore,
  nextOccurrenceAfter,
} from "@workmesh/api";

const iso = (d: Date): string => d.toISOString();
const next = (cron: string, tz: string, from: string, n = 1): string[] => {
  const out: string[] = [];
  let cursor = new Date(from);
  for (let i = 0; i < n; i++) {
    cursor = nextOccurrenceAfter(cron, tz, cursor);
    out.push(iso(cursor));
  }
  return out;
};

describe("cron arithmetic (semantics pinned from observed library behaviour)", () => {
  it("next occurrence is strictly after the reference instant", () => {
    assert.deepEqual(next("*/5 * * * *", "UTC", "2026-01-01T10:02:00Z", 2), [
      "2026-01-01T10:05:00.000Z",
      "2026-01-01T10:10:00.000Z",
    ]);
    // exactly on an occurrence: that occurrence is NOT returned again
    assert.deepEqual(next("*/5 * * * *", "UTC", "2026-01-01T10:05:00Z"), [
      "2026-01-01T10:10:00.000Z",
    ]);
  });

  it("latest occurrence at-or-before is INCLUSIVE of the reference instant", () => {
    const at = (s: string) => iso(latestOccurrenceAtOrBefore("*/5 * * * *", "UTC", new Date(s)));
    assert.equal(at("2026-01-01T10:05:00.000Z"), "2026-01-01T10:05:00.000Z");
    assert.equal(at("2026-01-01T10:04:59.999Z"), "2026-01-01T10:00:00.000Z");
    assert.equal(at("2026-01-01T12:03:00.000Z"), "2026-01-01T12:00:00.000Z");
  });

  it("evaluates in the schedule's time zone and returns absolute instants", () => {
    assert.deepEqual(next("0 9 * * *", "Asia/Kolkata", "2026-01-01T00:00:00Z", 2), [
      "2026-01-01T03:30:00.000Z",
      "2026-01-02T03:30:00.000Z",
    ]);
    // London is on UTC in winter and UTC+1 after the last Sunday of March (2026-03-29).
    assert.deepEqual(next("0 9 * * *", "Europe/London", "2026-03-27T12:00:00Z", 4), [
      "2026-03-28T09:00:00.000Z",
      "2026-03-29T08:00:00.000Z",
      "2026-03-30T08:00:00.000Z",
      "2026-03-31T08:00:00.000Z",
    ]);
  });

  it("DST spring forward: a nonexistent local time fires ONCE, shifted forward", () => {
    // 2026-03-08 in New York: clocks jump 02:00 -> 03:00, so 02:30 does not exist.
    assert.deepEqual(next("30 2 * * *", "America/New_York", "2026-03-06T12:00:00Z", 4), [
      "2026-03-07T07:30:00.000Z", // 02:30 EST
      "2026-03-08T07:30:00.000Z", // 03:30 EDT: shifted, not skipped
      "2026-03-09T06:30:00.000Z", // 02:30 EDT
      "2026-03-10T06:30:00.000Z",
    ]);
  });

  it("DST fall back: an ambiguous local time fires ONCE, at its first occurrence", () => {
    // 2026-11-01 in New York: 01:00-02:00 happens twice.
    assert.deepEqual(next("30 1 * * *", "America/New_York", "2026-10-30T12:00:00Z", 4), [
      "2026-10-31T05:30:00.000Z",
      "2026-11-01T05:30:00.000Z", // 01:30 EDT (first pass)
      "2026-11-02T06:30:00.000Z", // 01:30 EST on the next day: no second run on 11-01
      "2026-11-03T06:30:00.000Z",
    ]);
  });

  it("an hourly schedule fires every REAL hour across the fall-back repeat", () => {
    assert.deepEqual(next("0 * * * *", "America/New_York", "2026-11-01T04:30:00Z", 5), [
      "2026-11-01T05:00:00.000Z",
      "2026-11-01T06:00:00.000Z",
      "2026-11-01T07:00:00.000Z",
      "2026-11-01T08:00:00.000Z",
      "2026-11-01T09:00:00.000Z",
    ]);
  });
});

describe("describeScheduleProblem", () => {
  it("accepts ordinary five-field expressions in valid zones", () => {
    assert.equal(describeScheduleProblem("*/5 * * * *", "UTC"), null);
    assert.equal(describeScheduleProblem("0 9 * * 1-5", "America/New_York"), null);
    assert.equal(describeScheduleProblem("  30 2 1 * *  ", "Asia/Kolkata"), null);
  });

  it("rejects seconds fields and macros (bounds the rate to one job per minute)", () => {
    assert.match(describeScheduleProblem("* * * * * *", "UTC") ?? "", /exactly 5 fields/);
    assert.match(describeScheduleProblem("@daily", "UTC") ?? "", /exactly 5 fields/);
  });

  it("rejects unknown time zones with a clear message", () => {
    assert.match(describeScheduleProblem("* * * * *", "Mars/Olympus") ?? "", /unknown time zone/);
  });

  it("rejects out-of-range and garbage expressions", () => {
    assert.match(describeScheduleProblem("61 * * * *", "UTC") ?? "", /invalid cron/);
    assert.match(describeScheduleProblem("a b c d e", "UTC") ?? "", /invalid cron/);
  });
});
