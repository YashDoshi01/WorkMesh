import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isDatabaseUnavailable, isTransientDbError } from "../../apps/api/src/db/errors.js";

const withCode = (code: string): Error => Object.assign(new Error("x"), { code });

describe("isTransientDbError", () => {
  it("treats connection, rollback, resource and shutdown classes as transient", () => {
    for (const code of ["08006", "40P01", "40001", "53300", "57014", "58030"]) {
      assert.equal(isTransientDbError(withCode(code)), true, code);
    }
  });

  it("treats Node network errors as transient", () => {
    assert.equal(isTransientDbError(withCode("ECONNRESET")), true);
    assert.equal(isTransientDbError(withCode("ETIMEDOUT")), true);
  });

  it("treats data and logic errors as NOT transient", () => {
    for (const code of ["23505", "23514", "P0001", "22P02", "42703"]) {
      assert.equal(isTransientDbError(withCode(code)), false, code);
    }
    assert.equal(isTransientDbError(new Error("Invalid characters, got value: a")), false);
    assert.equal(isTransientDbError(null), false);
    assert.equal(isTransientDbError("string"), false);
  });
});

describe("isDatabaseUnavailable", () => {
  it("includes everything transient", () => {
    assert.equal(isDatabaseUnavailable(withCode("ECONNREFUSED")), true);
    assert.equal(isDatabaseUnavailable(withCode("57P01")), true);
  });

  it("includes the driver's code-less connection failures", () => {
    for (const message of [
      "timeout exceeded when trying to connect",
      "Connection terminated unexpectedly",
      "Connection terminated due to connection timeout",
      "Client has encountered a connection error and is not queryable",
    ]) {
      assert.equal(isDatabaseUnavailable(new Error(message)), true, message);
    }
  });

  it("does not turn bugs or data errors into 503s", () => {
    assert.equal(isDatabaseUnavailable(new Error("Cannot read properties of undefined")), false);
    assert.equal(isDatabaseUnavailable(withCode("23505")), false);
    assert.equal(isDatabaseUnavailable(withCode("42703")), false);
    assert.equal(isDatabaseUnavailable(null), false);
  });
});
