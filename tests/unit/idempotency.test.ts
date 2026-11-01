import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  IDEMPOTENCY_KEY_PATTERN,
  requestHash,
  stableStringify,
} from "../../apps/api/src/jobs/idempotency.js";
import { createJobSchema } from "../../apps/api/src/jobs/schema.js";

const parse = (body: unknown) => createJobSchema.parse(body);

describe("stableStringify", () => {
  it("sorts object keys at every depth and keeps array order", () => {
    assert.equal(
      stableStringify({ b: 1, a: { d: [3, 2], c: null } }),
      '{"a":{"c":null,"d":[3,2]},"b":1}',
    );
  });
  it("ignores undefined fields, like JSON does", () => {
    assert.equal(stableStringify({ a: 1, b: undefined }), '{"a":1}');
  });
});

describe("requestHash", () => {
  const base = { type: "t.x", payload: { a: 1, b: 2 } };

  it("is the same for the same request, whatever the key order or omitted defaults", () => {
    const explicit = parse({ ...base, priority: 0, maxAttempts: 3 });
    const implicit = parse({ payload: { b: 2, a: 1 }, type: "t.x" });
    assert.ok(requestHash(explicit).equals(requestHash(implicit)));
  });

  it("changes when anything about the request changes", () => {
    const h = requestHash(parse(base));
    for (const other of [
      { ...base, type: "t.y" },
      { ...base, payload: { a: 1, b: 3 } },
      { ...base, priority: 1 },
      { ...base, maxAttempts: 4 },
      { ...base, runAt: "2099-01-01T00:00:00Z" },
    ]) {
      assert.ok(!h.equals(requestHash(parse(other))), JSON.stringify(other));
    }
  });

  it("is 32 bytes (SHA-256)", () => {
    assert.equal(requestHash(parse(base)).length, 32);
  });
});

describe("the key pattern", () => {
  it("accepts 1-128 safe characters and nothing else", () => {
    for (const ok of ["a", "order-1024", "a.b_c:d-e", "X".repeat(128)])
      assert.ok(IDEMPOTENCY_KEY_PATTERN.test(ok), ok);
    for (const bad of ["", " ", "a b", "a/b", "x".repeat(129), "é"])
      assert.ok(!IDEMPOTENCY_KEY_PATTERN.test(bad), bad);
  });
});
