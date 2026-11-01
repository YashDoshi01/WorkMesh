// Operator command-line tool for machine API keys. It is a thin client of the operator plane
// (POST/GET /ops/keys), so it needs OPERATOR_API_KEY (read from .env) and a running API.
//
//   npm run keys -- create worker --account default --name "my laptop"
//   npm run keys -- create client --account default --name "billing service" --expires-days 90
//   npm run keys -- create worker --name "mailer" --job-types email.send,report.build
//   npm run keys -- list
//   npm run keys -- revoke <key id or prefix>
//
// --url http://host:port selects the API (default: $WORKMESH_API_URL or the gateway, :8080).

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const command = args[0];
const baseUrl = flag("url") ?? process.env.WORKMESH_API_URL ?? "http://localhost:8080";
const operatorKey = process.env.OPERATOR_API_KEY;

function usage(message?: string): never {
  if (message) console.error(`${message}\n`);
  console.error(
    [
      "usage:",
      "  npm run keys -- create <client|worker> [--account A] [--name N] [--job-types a,b] [--expires-days N] [--url U]",
      "  npm run keys -- list [--url U]",
      "  npm run keys -- revoke <key id or prefix> [--url U]",
    ].join("\n"),
  );
  process.exit(2);
}

if (!operatorKey) usage("OPERATOR_API_KEY is not set (put it in .env).");

interface KeyView {
  id: string;
  prefix: string;
  kind: string;
  account: string;
  name: string;
  status: string;
  lastUsedAt: string | null;
  secret?: string;
}
interface ApiReply {
  items?: KeyView[];
  error?: { message?: string; details?: unknown };
}

async function call(method: string, path: string, body?: unknown): Promise<ApiReply & KeyView> {
  const res = await fetch(new URL(path, baseUrl), {
    method,
    headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).catch((err: Error) => {
    console.error(
      `Cannot reach ${baseUrl} (${(err.cause as Error | undefined)?.message ?? err.message}).`,
    );
    console.error("Is the API (or `npm run gateway:up`) running? Use --url to point elsewhere.");
    process.exit(1);
  });
  const text = await res.text();
  const json = (text ? JSON.parse(text) : {}) as ApiReply & KeyView;
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${json?.error?.message ?? text}`);
    if (json?.error?.details) console.error(JSON.stringify(json.error.details));
    process.exit(1);
  }
  return json;
}

if (command === "create") {
  const kind = args[1];
  if (kind !== "client" && kind !== "worker") usage("kind must be 'client' or 'worker'");
  const jobTypes = flag("job-types");
  const days = flag("expires-days");
  const created = await call("POST", "/ops/keys", {
    kind,
    account: flag("account") ?? "default",
    name: flag("name") ?? `${kind} key`,
    ...(jobTypes ? { jobTypes: jobTypes.split(",").map((t) => t.trim()) } : {}),
    ...(days ? { expiresInDays: Number(days) } : {}),
  });
  console.log(`Created ${created.kind} key ${created.prefix} for account "${created.account}".`);
  console.log("\nThis is the ONLY time the key is shown. Store it now:\n");
  console.log(`  ${created.secret}\n`);
  if (created.kind === "worker") {
    console.log("Use it with the sample worker:");
    console.log(`  PowerShell:  $env:WORKMESH_API_KEY = "${created.secret}"; npm run dev:worker`);
  } else {
    console.log("Use it as a header on POST /jobs, /workflows, /schedules:");
    console.log(`  Authorization: Bearer ${created.secret}`);
  }
} else if (command === "list") {
  const items = (await call("GET", "/ops/keys")).items ?? [];
  if (items.length === 0) console.log("No keys yet.");
  for (const k of items) {
    console.log(
      [
        k.prefix,
        k.status.padEnd(7),
        k.kind.padEnd(6),
        `account=${k.account}`,
        `"${k.name}"`,
        `last used ${k.lastUsedAt ?? "never"}`,
        `id=${k.id}`,
      ].join("  "),
    );
  }
} else if (command === "revoke") {
  const target = args[1];
  if (!target) usage("give a key id or prefix");
  const items = (await call("GET", "/ops/keys")).items ?? [];
  const match = items.find((k) => k.id === target || k.prefix === target);
  if (!match) usage(`no key with id or prefix "${target}" (see: npm run keys -- list)`);
  const revoked = await call("POST", `/ops/keys/${match.id}/revoke`, {});
  console.log(`Revoked ${revoked.prefix} ("${revoked.name}"). It stops working immediately.`);
} else {
  usage();
}
