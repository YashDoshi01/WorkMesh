import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getRuntimeIdentity, WORKMESH_PHASE } from "@workmesh/api";
import { WORKMESH_NAME } from "@workmesh/shared";

describe("Phase 1 smoke", () => {
  it("identifies WorkMesh at phase 1", () => {
    const identity = getRuntimeIdentity();
    assert.equal(identity.name, WORKMESH_NAME);
    assert.equal(identity.phase, WORKMESH_PHASE);
    assert.equal(WORKMESH_PHASE, 1);
  });
});
