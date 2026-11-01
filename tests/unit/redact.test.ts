import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REDACTED, redact, redactString } from "@workmesh/shared";
import { generateKey, parseKey, digestsEqual } from "../../apps/api/src/keys/keys.js";

describe("log redaction", () => {
  it("replaces sensitive field names wholesale, at any depth", () => {
    const out = redact({
      requestId: "r1",
      headers: { authorization: "Bearer abc", "x-api-key": "k", accept: "json" },
      nested: { deeper: { password: "hunter2", fine: 1 } },
      list: [{ token: "t" }],
    }) as any;
    assert.equal(out.requestId, "r1");
    assert.equal(out.headers.authorization, REDACTED);
    assert.equal(out.headers["x-api-key"], REDACTED);
    assert.equal(out.headers.accept, "json");
    assert.equal(out.nested.deeper.password, REDACTED);
    assert.equal(out.nested.deeper.fine, 1);
    assert.equal(out.list[0].token, REDACTED);
  });

  it("never logs a job payload, whatever it contains", () => {
    const out = redact({ jobId: "j", payload: { ssn: "123-45-6789", to: "a@b.c" } }) as any;
    assert.equal(out.payload, REDACTED);
    assert.equal(out.jobId, "j");
  });

  it("masks a WorkMesh key that appears inside free text or an unexpected field", () => {
    const key = generateKey().secret;
    assert.ok(!redactString(`login failed for ${key} from 1.2.3.4`).includes(key));
    const out = redact({ note: `retrying with ${key}`, error: new Error(`bad key ${key}`) }) as any;
    assert.ok(!JSON.stringify(out).includes(key));
    assert.ok(!JSON.stringify(out).includes(key.slice(12)));
  });

  it("masks Bearer credentials and passwords inside connection strings", () => {
    assert.equal(
      redactString("Authorization: Bearer abcdef123456"),
      `Authorization: Bearer ${REDACTED}`,
    );
    const url = redactString(
      "connect postgres://workmesh:hunter2@db.internal:5432/workmesh failed",
    );
    assert.ok(!url.includes("hunter2"));
    assert.ok(url.includes("db.internal"), "the host stays useful for diagnosis");
  });

  it("does not choke on cycles or very deep objects", () => {
    const a: any = { name: "a" };
    a.self = a;
    const out = JSON.stringify(redact(a));
    assert.ok(out.includes("[truncated]"));
  });

  it("leaves ordinary values alone", () => {
    assert.deepEqual(redact({ n: 1, ok: true, s: "hello", nothing: null }), {
      n: 1,
      ok: true,
      s: "hello",
      nothing: null,
    });
  });
});

describe("API key format", () => {
  it("generates keys that parse back to a matching digest", () => {
    const k = generateKey();
    const parsed = parseKey(k.secret)!;
    assert.equal(parsed.prefix, k.prefix);
    assert.ok(digestsEqual(parsed.digest, k.digest));
  });

  it("the stored digest is not the key and does not contain it", () => {
    const k = generateKey();
    assert.ok(!k.digest.toString("utf8").includes(k.secret));
    assert.equal(k.digest.length, 32);
  });

  it("two keys never collide and have 256 bits of secret", () => {
    const a = generateKey();
    const b = generateKey();
    assert.notEqual(a.secret, b.secret);
    assert.equal(a.secret.slice(12).length, 43);
  });

  it("rejects anything not shaped like a key before any database lookup", () => {
    for (const bad of [
      "",
      "wm_",
      "abc",
      "wm_zzzzzzzz_" + "a".repeat(43),
      "wm_12345678_short",
      "Bearer x",
    ]) {
      assert.equal(parseKey(bad), null, bad);
    }
  });

  it("a changed secret gives a different digest", () => {
    const k = generateKey();
    const tampered = k.secret.slice(0, -1) + (k.secret.endsWith("A") ? "B" : "A");
    assert.ok(!digestsEqual(parseKey(tampered)!.digest, k.digest));
  });
});
