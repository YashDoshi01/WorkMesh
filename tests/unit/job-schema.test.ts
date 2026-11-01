import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createJobSchema, listJobsQuerySchema } from "@workmesh/api";

describe("createJobSchema", () => {
  it("accepts a minimal job and applies defaults", () => {
    const r = createJobSchema.parse({ type: "email.send", payload: { to: "a@b.c" } });
    assert.equal(r.priority, 0);
    assert.equal(r.runAt, undefined);
  });

  it("rejects bad types, non-object payloads, unknown keys and bad priority", () => {
    const bad = [
      { type: "Email Send", payload: {} },
      { type: "x", payload: [] },
      { type: "x", payload: "str" },
      { type: "x", payload: {}, priority: 101 },
      { type: "x", payload: {}, priority: 1.5 },
      { type: "x", payload: {}, status: "succeeded" },
      { type: "x", payload: {}, runAt: "tomorrow" },
    ];
    for (const b of bad) {
      assert.equal(createJobSchema.safeParse(b).success, false, JSON.stringify(b));
    }
  });

  it("rejects payloads over 64 KiB", () => {
    const r = createJobSchema.safeParse({ type: "x", payload: { blob: "a".repeat(70_000) } });
    assert.equal(r.success, false);
  });
});

describe("listJobsQuerySchema", () => {
  it("defaults and bounds the page size", () => {
    assert.equal(listJobsQuerySchema.parse({}).limit, 20);
    assert.equal(listJobsQuerySchema.safeParse({ limit: "101" }).success, false);
    assert.equal(listJobsQuerySchema.safeParse({ limit: "0" }).success, false);
    assert.equal(listJobsQuerySchema.parse({ limit: "5" }).limit, 5);
  });

  it("rejects unknown statuses", () => {
    assert.equal(listJobsQuerySchema.safeParse({ status: "bogus" }).success, false);
  });
});
