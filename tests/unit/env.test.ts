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
});
