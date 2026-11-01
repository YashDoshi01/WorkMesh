import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isValidTrustProxyEntry, parseEnv, parseTrustProxy } from "@workmesh/shared";

describe("TRUST_PROXY parsing", () => {
  it("accepts single addresses, narrow ranges and keywords", () => {
    for (const ok of [
      "172.28.57.10",
      "10.0.0.0/8",
      "192.168.1.0/24",
      "127.0.0.1/32",
      "::1",
      "fd00::/8",
      "loopback",
      "linklocal",
      "uniquelocal",
    ]) {
      assert.equal(isValidTrustProxyEntry(ok), true, ok);
    }
  });

  it("REFUSES anything that would trust every client", () => {
    for (const bad of ["true", "1", "2", "0.0.0.0/0", "::/0", "*", "all", "false"]) {
      assert.equal(isValidTrustProxyEntry(bad), false, bad);
    }
  });

  it("refuses malformed entries", () => {
    for (const bad of [
      "",
      "172.28.57",
      "172.28.57.10/33",
      "172.28.57.10/-1",
      "1.2.3.4/8/9",
      "::1/129",
      "host.name",
      "10.0.0.0/abc",
    ]) {
      assert.equal(isValidTrustProxyEntry(bad), false, JSON.stringify(bad));
    }
  });

  it("parses a list, ignoring spaces and empty items; unset means 'trust nobody'", () => {
    assert.deepEqual(parseTrustProxy(" 10.0.0.1 , loopback ,, "), ["10.0.0.1", "loopback"]);
    assert.equal(parseTrustProxy(undefined), undefined);
    assert.equal(parseTrustProxy("   "), undefined);
  });

  it("names every bad entry in the error", () => {
    assert.throws(() => parseTrustProxy("10.0.0.1,true,0.0.0.0/0"), /true, 0\.0\.0\.0\/0/);
  });
});

describe("environment: horizontal-scaling settings", () => {
  const base = {
    DATABASE_URL: "postgres://x",
    OPERATOR_API_KEY: "operator-key-0123456789",
    VIEWER_API_KEY: "viewer-key-0123456789ab",
  };

  it("has safe defaults (no proxy trusted, no instance id, 3 s drain, 20 s grace, 10 connections)", () => {
    const env = parseEnv(base);
    assert.equal(env.TRUST_PROXY, undefined);
    assert.equal(env.INSTANCE_ID, undefined);
    assert.equal(env.SHUTDOWN_DRAIN_MS, 3000);
    assert.equal(env.SHUTDOWN_GRACE_MS, 20_000);
    assert.equal(env.DB_POOL_MAX, 10);
  });

  it("rejects an unsafe TRUST_PROXY at startup, naming the variable", () => {
    assert.throws(() => parseEnv({ ...base, TRUST_PROXY: "true" }), /TRUST_PROXY/);
    assert.throws(() => parseEnv({ ...base, TRUST_PROXY: "0.0.0.0/0" }), /TRUST_PROXY/);
    assert.doesNotThrow(() => parseEnv({ ...base, TRUST_PROXY: "172.28.57.10" }));
  });

  it("validates the instance id and the numeric limits", () => {
    assert.throws(() => parseEnv({ ...base, INSTANCE_ID: "bad id!" }), /INSTANCE_ID/);
    assert.equal(parseEnv({ ...base, INSTANCE_ID: "api-1" }).INSTANCE_ID, "api-1");
    assert.throws(() => parseEnv({ ...base, SHUTDOWN_DRAIN_MS: "-1" }), /SHUTDOWN_DRAIN_MS/);
    assert.throws(() => parseEnv({ ...base, SHUTDOWN_GRACE_MS: "10" }), /SHUTDOWN_GRACE_MS/);
    assert.throws(() => parseEnv({ ...base, DB_POOL_MAX: "0" }), /DB_POOL_MAX/);
  });
});
