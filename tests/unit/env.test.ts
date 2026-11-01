import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEnv } from "@workmesh/shared";

const KEYS = {
  OPERATOR_API_KEY: "operator-key-0123456789",
  VIEWER_API_KEY: "viewer-key-0123456789ab",
};

describe("parseEnv", () => {
  it("accepts a complete local configuration", () => {
    const env = parseEnv({
      NODE_ENV: "test",
      PORT: "3000",
      DATABASE_URL: "postgres://workmesh:workmesh@localhost:5432/workmesh",
      ...KEYS,
    });

    assert.equal(env.NODE_ENV, "test");
    assert.equal(env.PORT, 3000);
    assert.match(env.DATABASE_URL, /^postgres:\/\//);
  });

  it("rejects a missing DATABASE_URL", () => {
    assert.throws(() => parseEnv({ NODE_ENV: "test" }), /DATABASE_URL/);
  });

  it("applies reliability defaults (30 s lease, 1 s base / 5 min cap backoff, 5 s sweep)", () => {
    const env = parseEnv({ DATABASE_URL: "postgres://x", ...KEYS });
    assert.equal(env.LEASE_MS, 30_000);
    assert.equal(env.RETRY_BASE_MS, 1000);
    assert.equal(env.RETRY_MAX_MS, 300_000);
    assert.equal(env.REAPER_INTERVAL_MS, 5000);
    assert.equal(env.SCHEDULER_INTERVAL_MS, 1000);
  });

  it("rejects out-of-range or non-numeric reliability settings", () => {
    const base = { DATABASE_URL: "postgres://x", ...KEYS };
    assert.throws(() => parseEnv({ ...base, LEASE_MS: "10" }), /LEASE_MS/);
    assert.throws(() => parseEnv({ ...base, RETRY_BASE_MS: "0" }), /RETRY_BASE_MS/);
    assert.throws(() => parseEnv({ ...base, REAPER_INTERVAL_MS: "abc" }), /REAPER_INTERVAL_MS/);
    assert.throws(() => parseEnv({ ...base, SCHEDULER_INTERVAL_MS: "5" }), /SCHEDULER_INTERVAL_MS/);
  });

  it("requires both operator keys and gives them no defaults", () => {
    assert.throws(() => parseEnv({ DATABASE_URL: "postgres://x" }), /OPERATOR_API_KEY/);
    assert.throws(
      () => parseEnv({ DATABASE_URL: "postgres://x", OPERATOR_API_KEY: KEYS.OPERATOR_API_KEY }),
      /VIEWER_API_KEY/,
    );
  });

  it("rejects short keys and identical keys", () => {
    const base = { DATABASE_URL: "postgres://x" };
    assert.throws(
      () => parseEnv({ ...base, OPERATOR_API_KEY: "short", VIEWER_API_KEY: KEYS.VIEWER_API_KEY }),
      /at least 16/,
    );
    assert.throws(
      () =>
        parseEnv({
          ...base,
          OPERATOR_API_KEY: KEYS.OPERATOR_API_KEY,
          VIEWER_API_KEY: KEYS.OPERATOR_API_KEY,
        }),
      /must differ/,
    );
  });

  it("refuses the .env.example placeholder in production, but tolerates it in development", () => {
    const placeholders = {
      DATABASE_URL: "postgres://x",
      OPERATOR_API_KEY: "change-me-operator-key-0001",
      VIEWER_API_KEY: "change-me-viewer-key-00002",
    };
    assert.doesNotThrow(() => parseEnv({ ...placeholders, NODE_ENV: "development" }));
    assert.throws(() => parseEnv({ ...placeholders, NODE_ENV: "production" }), /placeholder/);
  });
});
