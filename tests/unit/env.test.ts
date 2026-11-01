import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEnv } from "@workmesh/shared";

describe("parseEnv", () => {
  it("accepts a complete local configuration", () => {
    const env = parseEnv({
      NODE_ENV: "test",
      PORT: "3000",
      DATABASE_URL: "postgres://workmesh:workmesh@localhost:5432/workmesh",
    });

    assert.equal(env.NODE_ENV, "test");
    assert.equal(env.PORT, 3000);
    assert.match(env.DATABASE_URL, /^postgres:\/\//);
  });

  it("rejects a missing DATABASE_URL", () => {
    assert.throws(() => parseEnv({ NODE_ENV: "test" }), /DATABASE_URL/);
  });

  it("applies reliability defaults (30 s lease, 1 s base / 5 min cap backoff, 5 s sweep)", () => {
    const env = parseEnv({ DATABASE_URL: "postgres://x" });
    assert.equal(env.LEASE_MS, 30_000);
    assert.equal(env.RETRY_BASE_MS, 1000);
    assert.equal(env.RETRY_MAX_MS, 300_000);
    assert.equal(env.REAPER_INTERVAL_MS, 5000);
  });

  it("rejects out-of-range or non-numeric reliability settings", () => {
    const base = { DATABASE_URL: "postgres://x" };
    assert.throws(() => parseEnv({ ...base, LEASE_MS: "10" }), /LEASE_MS/);
    assert.throws(() => parseEnv({ ...base, RETRY_BASE_MS: "0" }), /RETRY_BASE_MS/);
    assert.throws(() => parseEnv({ ...base, REAPER_INTERVAL_MS: "abc" }), /REAPER_INTERVAL_MS/);
  });
});
