import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

// Shared pieces of the benchmark harness: an isolated Docker stack, a closed-loop load
// generator, percentile maths, container CPU sampling, and result files.
// Nothing here talks to the stack you run by hand: it has its own project name, port and subnet.

export const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const COMPOSE_FILE = "infra/compose.gateway.yaml";

export const OPERATOR_KEY = "bench-operator-key-0123456789abcdef";
export const VIEWER_KEY = "bench-viewer-key-0123456789abcdef";

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Runs a command WITHOUT blocking the event loop. This matters: the load generator lives in this
 * same Node process, and a synchronous `spawnSync` (docker kill, docker stats, ...) would freeze
 * every load lane while it runs, so the experiment would not be sending traffic at the very moment
 * it injects a fault. (The first version of this harness did exactly that, and reported "0 failures
 * when an API instance is killed under load" for the wrong reason.)
 */
export function run(
  command: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// ------------------------------------------------------------------------------ statistics
export interface LatencySummary {
  n: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

/** Nearest-rank percentile of an ASCENDING array. */
function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1]!;
}

const round = (v: number, digits = 2): number => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

export function summarize(samplesMs: number[]): LatencySummary {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    meanMs: round(sum / (sorted.length || 1)),
    p50Ms: round(pct(sorted, 50)),
    p95Ms: round(pct(sorted, 95)),
    p99Ms: round(pct(sorted, 99)),
    maxMs: round(sorted[sorted.length - 1] ?? NaN),
  };
}

// ------------------------------------------------------------------------ load generation
export interface LoadResult {
  concurrency: number;
  durationS: number;
  /** Requests that returned a 2xx status, per second of measured time. */
  throughputPerS: number;
  total: number;
  byStatus: Record<string, number>;
  latencyOk: LatencySummary;
  /** Little's Law check: L = lambda x W. `impliedInFlight` should be close to `concurrency`. */
  impliedInFlight: number;
}

/**
 * Closed-loop load: `concurrency` lanes each send a request, wait for the answer, and send the
 * next one immediately. This measures the system's capacity at that concurrency (as opposed to an
 * open loop, which sends at a fixed rate regardless of answers). The first `warmupMs` are discarded.
 */
export async function closedLoop(opts: {
  concurrency: number;
  durationMs: number;
  warmupMs: number;
  request: (seq: number) => Promise<number | string>;
}): Promise<LoadResult> {
  const startAt = performance.now();
  const measureFrom = startAt + opts.warmupMs;
  const endAt = measureFrom + opts.durationMs;
  const okLatencies: number[] = [];
  const byStatus: Record<string, number> = {};
  let total = 0;
  let seq = 0;

  const lane = async (): Promise<void> => {
    while (performance.now() < endAt) {
      const t0 = performance.now();
      let status: number | string;
      try {
        status = await opts.request(seq++);
      } catch (error) {
        status = `error:${(error as Error).cause ? String((error as { cause: { code?: string } }).cause.code ?? "cause") : (error as Error).name}`;
      }
      const t1 = performance.now();
      if (t0 < measureFrom) continue;
      total++;
      byStatus[String(status)] = (byStatus[String(status)] ?? 0) + 1;
      if (typeof status === "number" && status >= 200 && status < 300) okLatencies.push(t1 - t0);
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency }, lane));

  const latencyOk = summarize(okLatencies);
  const okCount = okLatencies.length;
  const throughputPerS = okCount / (opts.durationMs / 1000);
  return {
    concurrency: opts.concurrency,
    durationS: opts.durationMs / 1000,
    throughputPerS: round(throughputPerS, 1),
    total,
    byStatus,
    latencyOk,
    impliedInFlight: round((throughputPerS * latencyOk.meanMs) / 1000, 2),
  };
}

// ---------------------------------------------------------------------------- CPU sampling
export interface CpuUse {
  /** Mean and peak CPU in "cores" (100% = one core fully busy) over the sampled period. */
  [service: string]: { meanCores: number; peakCores: number; samples: number };
}

/** Samples `docker stats` every couple of seconds until stopped. */
export function sampleDockerCpu(project: string): { stop: () => Promise<CpuUse> } {
  const rows = new Map<string, number[]>();
  let running = true;
  const loop = (async () => {
    while (running) {
      const out = await run("docker", [
        "stats",
        "--no-stream",
        "--format",
        "{{.Name}}|{{.CPUPerc}}",
      ]);
      for (const line of out.stdout.split(/\r?\n/)) {
        const [name, cpu] = line.trim().split("|");
        if (!name?.startsWith(`${project}-`) || !cpu) continue;
        const service = name.slice(project.length + 1).replace(/-\d+$/, "");
        const value = Number.parseFloat(cpu.replace("%", "")) / 100;
        if (Number.isFinite(value)) rows.set(service, [...(rows.get(service) ?? []), value]);
      }
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      const result: CpuUse = {};
      for (const [service, values] of rows) {
        result[service] = {
          meanCores: round(values.reduce((a, b) => a + b, 0) / values.length),
          peakCores: round(Math.max(...values)),
          samples: values.length,
        };
      }
      return result;
    },
  };
}

// ------------------------------------------------------------------------------ the stack
export interface StackOptions {
  /** `shipped` keeps the gateway's real rate limits; `lifted` removes them so capacity can be measured. */
  limits: "shipped" | "lifted";
  extraEnv?: Record<string, string>;
}

export class Stack {
  readonly project = "workmesh-bench";
  readonly port = 18090;
  readonly subnet = "172.28.60";
  readonly url = `http://127.0.0.1:${this.port}`;
  clientKey = "";
  workerKey = "";

  constructor(private opts: StackOptions) {}

  private confPath(): string {
    if (this.opts.limits === "shipped") return `${ROOT}/infra/nginx/nginx.conf`;
    const source = readFileSync(`${ROOT}/infra/nginx/nginx.conf`, "utf8");
    // Lift every limit by name so a change to the shipped numbers cannot silently survive.
    const lifted = source
      .replace(/rate=\d+r\/[sm]/g, "rate=1000000r/s")
      .replace(/limit_conn per_address \d+;/, "limit_conn per_address 60000;")
      .replace(/burst=\d+/g, "burst=1000000");
    mkdirSync(`${ROOT}/bench/.generated`, { recursive: true });
    const path = `${ROOT}/bench/.generated/nginx.lifted.conf`;
    writeFileSync(path, lifted);
    return path;
  }

  private env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GATEWAY_PROJECT: this.project,
      GATEWAY_PORT: String(this.port),
      GATEWAY_SUBNET_PREFIX: this.subnet,
      GATEWAY_NGINX_CONF: this.confPath(),
      OPERATOR_API_KEY: OPERATOR_KEY,
      VIEWER_API_KEY: VIEWER_KEY,
      ...this.opts.extraEnv,
    };
  }

  compose(args: string[], opts: { allowFail?: boolean; input?: string } = {}): string {
    const r = spawnSync("docker", ["compose", "-f", COMPOSE_FILE, ...args], {
      cwd: ROOT,
      env: this.env(),
      encoding: "utf8",
      timeout: 600_000,
      ...(opts.input === undefined ? {} : { input: opts.input }),
    });
    if (r.status !== 0 && !opts.allowFail) {
      throw new Error(`docker compose ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
    }
    return r.stdout;
  }

  /** Like `compose`, but does not block the event loop (use it while load is running). */
  async composeAsync(args: string[]): Promise<void> {
    const r = await run("docker", ["compose", "-f", COMPOSE_FILE, ...args], {
      cwd: ROOT,
      env: this.env(),
    });
    if (r.code !== 0)
      throw new Error(`docker compose ${args.join(" ")} failed:
${r.stdout}
${r.stderr}`);
  }

  container(service: string): string {
    return `${this.project}-${service}-1`;
  }

  /** Starts a clean stack (fresh database) and issues one client key and one worker key. */
  async up(build: boolean): Promise<void> {
    this.compose(["down", "-v", "--remove-orphans"], { allowFail: true });
    this.compose(["up", "-d", ...(build ? ["--build"] : [])]);
    await this.waitReady();
    this.clientKey = await this.issueKey("client");
    this.workerKey = await this.issueKey("worker");
  }

  /** Recreates both API instances with different environment (the database and its keys persist). */
  async setApiEnv(env: Record<string, string>): Promise<void> {
    this.opts = { ...this.opts, extraEnv: { ...this.opts.extraEnv, ...env } };
    this.compose(["up", "-d", "--force-recreate", "--no-deps", "api-1", "api-2"]);
    await this.waitReady();
    await sleep(12_000); // let the gateway's passive health check re-admit both instances
  }

  /** Restarts only the gateway, with different rate-limit settings. */
  async setLimits(limits: "shipped" | "lifted"): Promise<void> {
    this.opts = { ...this.opts, limits };
    this.compose(["up", "-d", "--force-recreate", "--no-deps", "gateway"]);
    await this.waitReady();
  }

  async down(): Promise<void> {
    this.compose(["down", "-v", "--remove-orphans"], { allowFail: true });
  }

  async waitReady(timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`${this.url}/readyz`)).status === 200) return;
      } catch {
        /* not yet */
      }
      await sleep(500);
    }
    throw new Error("the bench stack did not become ready");
  }

  private async issueKey(kind: "client" | "worker"): Promise<string> {
    const res = await fetch(`${this.url}/ops/keys`, {
      method: "POST",
      headers: { authorization: `Bearer ${OPERATOR_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ kind, account: "bench", name: `bench-${kind}` }),
    });
    if (res.status !== 201) throw new Error(`could not create a ${kind} key: ${res.status}`);
    return ((await res.json()) as { secret: string }).secret;
  }

  /** Runs SQL inside the stack's PostgreSQL and returns rows of text columns. */
  sql(query: string): string[][] {
    const r = spawnSync(
      "docker",
      [
        "exec",
        "-i",
        this.container("postgres"),
        "psql",
        "-U",
        "workmesh",
        "-d",
        "workmesh",
        "-q",
        "-At",
        "-F",
        "|",
        "-v",
        "ON_ERROR_STOP=1",
      ],
      { input: query, encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}\n${query}`);
    return r.stdout
      .split("\n")
      .filter((l) => l.length > 0 && !/^(TRUNCATE|INSERT|UPDATE|DELETE|SET)\b/.test(l))
      .map((l) => l.split("|"));
  }

  sqlNumber(query: string): number {
    return Number(this.sql(query)[0]?.[0] ?? "NaN");
  }

  async post(path: string, key: string, body: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${this.url}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? safeJson(text) : undefined };
  }

  async get(path: string, key: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`${this.url}${path}`, { headers: { authorization: `Bearer ${key}` } });
    const text = await res.text();
    return { status: res.status, body: text ? safeJson(text) : undefined };
  }

  /** Submits a job as the bench client. Returns the HTTP status. */
  async submit(
    payload: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): Promise<number> {
    return (await this.post("/jobs", this.clientKey, { type: "bench.job", payload, ...extra }))
      .status;
  }

  resetData(): void {
    this.sql("TRUNCATE jobs, workers, job_attempts CASCADE;");
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ------------------------------------------------------------------------------ processes
export interface WorkerProc {
  proc: ChildProcess;
  kill: () => void;
}

/** Starts a real worker process (the SDK, in its own Node process, like a customer's would be). */
export function startWorker(stack: Stack, concurrency: number): WorkerProc {
  const proc = spawn(process.execPath, ["--import", "tsx", "bench/worker.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      WORKMESH_API_URL: stack.url,
      WORKMESH_API_KEY: stack.workerKey,
      WORKER_CONCURRENCY: String(concurrency),
    },
    stdio: "ignore",
  });
  return {
    proc,
    kill: () => {
      if (proc.pid && proc.exitCode === null) {
        spawnSync("taskkill", ["/F", "/T", "/PID", String(proc.pid)], { stdio: "ignore" });
      }
    },
  };
}

// --------------------------------------------------------------------------------- results
export function environment(): Record<string, unknown> {
  const dockerInfo = spawnSync(
    "docker",
    ["info", "--format", "{{.NCPU}}|{{.MemTotal}}|{{.ServerVersion}}"],
    { encoding: "utf8" },
  )
    .stdout.trim()
    .split("|");
  const cpu = os.cpus()[0];
  return {
    capturedAt: new Date().toISOString(),
    host: {
      os: `${os.type()} ${os.release()}`,
      cpu: cpu?.model.trim(),
      logicalCores: os.cpus().length,
      memoryGiB: round(os.totalmem() / 2 ** 30, 1),
      node: process.version,
    },
    docker: {
      engine: dockerInfo[2],
      vmCpus: Number(dockerInfo[0]),
      vmMemoryGiB: round(Number(dockerInfo[1]) / 2 ** 30, 1),
    },
    topology:
      "load generator, NGINX, 2 API containers, PostgreSQL 17.6 and workers all on this one machine; the load generator competes for the same CPUs",
    images: {
      nginx: "nginx:1.28-alpine",
      postgres: "postgres:17.6-alpine",
      api: "node:24.14.1-alpine3.22 + tsx (TypeScript run directly)",
    },
    apiConfig: { dbPoolMax: 10, instances: 2, nodeEnv: "development" },
  };
}

export function saveResult(name: string, data: unknown): string {
  mkdirSync(`${ROOT}/bench/results`, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const path = `${ROOT}/bench/results/${stamp}-${name}.json`;
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  return path;
}

export const fmt = (n: number, digits = 1): string =>
  Number.isFinite(n) ? n.toFixed(digits) : "n/a";
