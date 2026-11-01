import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Authenticator, principalOf, requireRole } from "../../apps/api/src/ops/auth.js";

const OPERATOR = "operator-key-0123456789";
const VIEWER = "viewer-key-abcdefghijkl";
const auth = new Authenticator({ operatorKey: OPERATOR, viewerKey: VIEWER });

/** Runs the middleware against a fake request and reports what it did. */
function run(header: string | undefined) {
  const req: any = {
    header: (name: string) => (name.toLowerCase() === "authorization" ? header : undefined),
  };
  let error: any;
  auth.authenticate(req, {} as any, (e?: unknown) => {
    error = e;
  });
  return { principal: req.principal as { role: string; actor: string } | undefined, error };
}

describe("Authenticator", () => {
  it("identifies the operator and the viewer by their keys", () => {
    assert.equal(run(`Bearer ${OPERATOR}`).principal?.role, "operator");
    assert.equal(run(`Bearer ${VIEWER}`).principal?.role, "viewer");
  });

  it("accepts the scheme in any case", () => {
    assert.equal(run(`bearer ${OPERATOR}`).principal?.role, "operator");
    assert.equal(run(`BEARER ${OPERATOR}`).principal?.role, "operator");
  });

  it("rejects missing, malformed and wrong credentials with 401", () => {
    for (const header of [
      undefined,
      "",
      "Bearer",
      "Bearer ",
      OPERATOR,
      `Basic ${OPERATOR}`,
      `Bearer ${OPERATOR} extra`,
      "Bearer wrong-key-0000000000",
      `Bearer ${OPERATOR}x`,
      `Bearer ${OPERATOR.slice(0, -1)}`,
    ]) {
      const { principal, error } = run(header);
      assert.equal(principal, undefined, String(header));
      assert.equal(error?.status, 401, String(header));
    }
  });

  it("an error never echoes the presented key", () => {
    const { error } = run("Bearer some-secret-value-12345");
    assert.ok(
      !JSON.stringify({ message: error.message, code: error.code }).includes("some-secret-value"),
    );
  });

  it("the actor is a short fingerprint, not the key, and differs per key", () => {
    const op = run(`Bearer ${OPERATOR}`).principal!;
    const vw = run(`Bearer ${VIEWER}`).principal!;
    assert.match(op.actor, /^operator:[0-9a-f]{8}$/);
    assert.match(vw.actor, /^viewer:[0-9a-f]{8}$/);
    assert.ok(!op.actor.includes(OPERATOR));
    assert.notEqual(op.actor, vw.actor);
    assert.equal(run(`Bearer ${OPERATOR}`).principal!.actor, op.actor, "stable across requests");
  });
});

describe("requireRole", () => {
  const check = (needs: "viewer" | "operator", role?: "viewer" | "operator") => {
    let error: any;
    requireRole(needs)(
      { principal: role ? { role, actor: "x" } : undefined } as any,
      {} as any,
      (e?: unknown) => {
        error = e;
      },
    );
    return error;
  };

  it("lets an equal or higher role through", () => {
    assert.equal(check("viewer", "viewer"), undefined);
    assert.equal(check("viewer", "operator"), undefined);
    assert.equal(check("operator", "operator"), undefined);
  });

  it("refuses a lower role with 403 and a missing identity with 401", () => {
    assert.equal(check("operator", "viewer").status, 403);
    assert.equal(check("viewer", undefined).status, 401);
    assert.equal(check("operator", undefined).status, 401);
  });

  it("principalOf throws 401 when nobody authenticated", () => {
    assert.throws(
      () => principalOf({}),
      (e: any) => e.status === 401,
    );
  });
});
