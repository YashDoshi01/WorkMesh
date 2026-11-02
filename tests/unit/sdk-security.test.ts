import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { ApiError, WorkMesh, WorkMeshClient } from "../../packages/worker-sdk/src/index.js";
import {
  checkApiKey,
  checkBaseUrl,
  cleanServerText,
} from "../../packages/worker-sdk/src/security.js";

const KEY = "wm_12345678_" + "a".repeat(43);

const rejects = (fn: () => unknown, code = "invalid_input") =>
  assert.throws(fn, (e: unknown) => e instanceof ApiError && e.code === code);

describe("sdk security: the base URL", () => {
  it("accepts https anywhere and http only for the local machine", () => {
    for (const u of [
      "https://workmesh.example.com",
      "https://workmesh.example.com/",
      "http://localhost:3000",
      "http://127.0.0.1:8080",
      "http://[::1]:3000",
    ]) {
      assert.equal(checkBaseUrl(u), u);
    }
  });

  it("refuses plain http to a remote host unless explicitly allowed", () => {
    rejects(() => checkBaseUrl("http://workmesh.example.com"));
    rejects(() => checkBaseUrl("http://10.0.0.5:3000"));
    // a name that merely contains "localhost" is a different host
    rejects(() => checkBaseUrl("http://localhost.evil.example"));
    assert.equal(checkBaseUrl("http://10.0.0.5:3000", true), "http://10.0.0.5:3000");
  });

  it("refuses other schemes, credentials in the URL and garbage", () => {
    rejects(() => checkBaseUrl("ftp://workmesh.example.com"));
    rejects(() => checkBaseUrl("file:///etc/passwd"));
    rejects(() => checkBaseUrl("javascript:alert(1)"));
    rejects(() => checkBaseUrl("https://user:pass@workmesh.example.com"));
    rejects(() => checkBaseUrl("https://user@workmesh.example.com"));
    rejects(() => checkBaseUrl("not a url"));
    rejects(() => checkBaseUrl(""));
  });

  it("is enforced by both halves of the SDK", () => {
    rejects(() => new WorkMesh({ apiUrl: "http://workmesh.example.com", apiKey: KEY }));
    rejects(() => new WorkMeshClient("http://workmesh.example.com", 1000, undefined, KEY));
    // and can be overridden on purpose
    new WorkMesh({ apiUrl: "http://10.0.0.5:3000", apiKey: KEY, allowInsecureHttp: true });
  });
});

describe("sdk security: the API key", () => {
  it("accepts a normal key and refuses anything that could inject a header", () => {
    checkApiKey(KEY);
    for (const k of [
      "",
      "short",
      `${KEY}\r\nx-evil: 1`,
      `${KEY}\n`,
      `${KEY} `,
      ` ${KEY}`,
      `wm_é_${"a".repeat(40)}`,
      "a".repeat(513),
    ]) {
      rejects(() => checkApiKey(k));
    }
  });

  it("never repeats a rejected key in the error", () => {
    const secret = `wm_aaaaaaaa_${"S3cr3t".repeat(5)}\nx-evil: 1`;
    try {
      new WorkMesh({ apiUrl: "https://workmesh.example.com", apiKey: secret });
      assert.fail("should have thrown");
    } catch (e) {
      assert.ok(e instanceof ApiError);
      assert.ok(!e.message.includes("S3cr3t"));
    }
  });
});

describe("sdk security: text that came from the server", () => {
  it("removes control characters and caps the length", () => {
    assert.equal(cleanServerText("a\u001b[31mred\u001b[0m\nb\r\nc\u0000d"), "a [31mred [0m b  c d");
    assert.equal(cleanServerText("x".repeat(5000)).length, 500);
    assert.equal(cleanServerText("ok"), "ok");
  });
});

describe("sdk security: behaviour against a hostile or broken server", () => {
  let server: Server;
  let base: string;
  const seen: { path: string; auth: string | undefined }[] = [];
  let mode = "redirect";

  before(async () => {
    server = createServer((req, res) => {
      seen.push({ path: req.url ?? "", auth: req.headers.authorization });
      if (mode === "redirect") {
        res.writeHead(302, { location: "/steal" });
        res.end();
      } else if (mode === "html") {
        res.writeHead(502, { "content-type": "text/html" });
        res.end("<html><body>Bad gateway: Bearer leaked-in-page</body></html>");
      } else if (mode === "html-200") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html>not json</html>");
      } else {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              code: "bad\u001b[2J",
              message: "line1\nFAKE LOG LINE\u001b[31m" + "z".repeat(900),
            },
          }),
        );
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  it("does not follow a redirect (the key must not be carried elsewhere)", async () => {
    mode = "redirect";
    seen.length = 0;
    const wm = new WorkMesh({ apiUrl: base, apiKey: KEY, maxRetries: 0 });
    await assert.rejects(wm.jobs.get("00000000-0000-0000-0000-000000000000"));
    assert.equal(seen.length, 1, "only the first request was made; the redirect was not followed");
    const client = new WorkMeshClient(base, 2000, undefined, KEY);
    await assert.rejects(client.heartbeat("00000000-0000-0000-0000-000000000000"));
    assert.equal(seen.length, 2);
  });

  it("turns a non-JSON error page into a clean ApiError without quoting the page", async () => {
    mode = "html";
    const client = new WorkMeshClient(base, 2000, undefined, KEY);
    await assert.rejects(
      client.heartbeat("00000000-0000-0000-0000-000000000000"),
      (e: unknown) =>
        e instanceof ApiError &&
        e.status === 502 &&
        !e.message.includes("leaked-in-page") &&
        !e.message.includes("<html"),
    );
  });

  it("treats a 200 that is not JSON as a bad response, not a crash", async () => {
    mode = "html-200";
    const client = new WorkMeshClient(base, 2000, undefined, KEY);
    await assert.rejects(
      client.heartbeat("00000000-0000-0000-0000-000000000000"),
      (e: unknown) => e instanceof ApiError && e.code === "bad_response",
    );
  });

  it("cleans server-supplied error text before it reaches the developer", async () => {
    mode = "forged";
    const wm = new WorkMesh({ apiUrl: base, apiKey: KEY, maxRetries: 0 });
    await assert.rejects(
      wm.jobs.submit({ type: "x.y" }),
      (e: unknown) =>
        e instanceof ApiError &&
        // eslint-disable-next-line no-control-regex
        !/[\u0000-\u001f]/.test(e.message) &&
        // eslint-disable-next-line no-control-regex
        !/[\u0000-\u001f]/.test(e.code) &&
        e.message.length <= 500,
    );
  });
});
