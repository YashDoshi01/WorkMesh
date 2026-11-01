import { spawnSync } from "node:child_process";
import {
  closedLoop,
  fmt,
  sampleDockerCpu,
  sleep,
  startWorker,
  summarize,
  VIEWER_KEY,
  type LoadResult,
  type Stack,
  type WorkerProc,
} from "./lib.js";

// Each scenario returns plain data (it is saved as JSON) and prints a short human summary.
// Scenarios that test failure state EXPECTED behaviour first, then report what was OBSERVED.

const say = (text: string): void => console.log(text);

function row(r: LoadResult): string {
  const ok = Object.entries(r.byStatus)
    .map(([k, v]) => `${k}:${v}`)
    .join(" ");
  return `  c=${String(r.concurrency).padEnd(4)} ${fmt(r.throughputPerS, 0).padStart(6)} ok/s   p50 ${fmt(r.latencyOk.p50Ms).padStart(7)} ms  p95 ${fmt(r.latencyOk.p95Ms).padStart(7)} ms  p99 ${fmt(r.latencyOk.p99Ms).padStart(7)} ms  inflight(L=lambda*W) ${r.impliedInFlight}   [${ok}]`;
}

/** A fast submitter: one POST /jobs per call, returns the HTTP status. */
const keyHeader = (key: string | undefined): Record<string, string> =>
  key === undefined ? {} : { "idempotency-key": key };

function submitter(
  stack: Stack,
  extra: (i: number) => Record<string, unknown> = () => ({}),
  /** Returns an Idempotency-Key for request number i (or undefined for none). */
  idempotencyKey: (i: number) => string | undefined = () => undefined,
) {
  const headers = {
    authorization: `Bearer ${stack.clientKey}`,
    "content-type": "application/json",
  };
  return async (i: number): Promise<number> => {
    const res = await fetch(`${stack.url}/jobs`, {
      method: "POST",
      headers: { ...headers, ...keyHeader(idempotencyKey(i)) },
      body: JSON.stringify({ type: "bench.job", payload: { n: i, ...extra(i) } }),
    });
    await res.arrayBuffer();
    return res.status;
  };
}

/** Sends exactly `total` requests with `concurrency` lanes; keeps each request's latency in order. */
async function countedLoop(
  total: number,
  concurrency: number,
  request: (i: number) => Promise<number>,
) {
  const latencies = new Array<number>(total).fill(0);
  const statuses = new Array<number>(total).fill(0);
  let next = 0;
  const lane = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= total) return;
      const t0 = performance.now();
      try {
        statuses[i] = await request(i);
      } catch {
        statuses[i] = -1;
      }
      latencies[i] = performance.now() - t0;
    }
  };
  const t0 = performance.now();
  await Promise.all(Array.from({ length: concurrency }, lane));
  return { latencies, statuses, seconds: (performance.now() - t0) / 1000 };
}

async function seed(
  stack: Stack,
  count: number,
  payload: (i: number) => Record<string, unknown>,
): Promise<void> {
  const { statuses } = await countedLoop(count, 64, submitter(stack, payload));
  const bad = statuses.filter((s) => s !== 201).length;
  if (bad > 0) throw new Error(`seeding failed for ${bad} of ${count} jobs`);
}

async function until(
  what: string,
  timeoutMs: number,
  check: () => boolean | Promise<boolean>,
  everyMs = 500,
): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await check()) return Date.now() - t0;
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Difference between the database clock and this machine's clock (database minus host), in ms. */
function clockOffsetMs(stack: Stack): number {
  const before = Date.now();
  const db = stack.sqlNumber("SELECT extract(epoch FROM clock_timestamp()) * 1000;");
  const after = Date.now();
  return Math.round(db - (before + after) / 2);
}

const killProc = (pid: number): void =>
  void spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });

// =========================================================================== PERFORMANCE
/** Submission throughput and latency through NGINX, at several concurrency levels. */
export async function submitScenario(stack: Stack) {
  const result: Record<string, unknown> = {};
  say("\n[submit] POST /jobs through the gateway, 2 API instances");

  say(" a) the SHIPPED rate limits (machine zone: 200 r/s, burst 400), 10 s at c=64");
  stack.resetData();
  const limited = await closedLoop({
    concurrency: 64,
    warmupMs: 2000,
    durationMs: 10_000,
    request: submitter(stack),
  });
  say(row(limited));
  result.withShippedLimits = limited;

  await stack.setLimits("lifted");
  say(" b) limits lifted, 2 instances (capacity), 15 s per level after 3 s warm-up");
  const sweep: Array<LoadResult & { cpu: unknown }> = [];
  for (const c of [1, 4, 16, 64, 128]) {
    stack.resetData();
    const cpu = sampleDockerCpu(stack.project);
    const r = await closedLoop({
      concurrency: c,
      warmupMs: 3000,
      durationMs: 15_000,
      request: submitter(stack),
    });
    const cpuUse = await cpu.stop();
    say(row(r));
    const rows = stack.sqlNumber("SELECT count(*) FROM jobs;");
    const acked = (r.byStatus["201"] ?? 0) + 0;
    sweep.push({ ...r, cpu: cpuUse });
    // Integrity: every acknowledged job exists (rows include the warm-up's, so rows >= acked).
    if (rows < acked)
      throw new Error(`rows ${rows} < acknowledged ${acked}: acknowledged jobs are missing`);
  }
  result.twoInstances = sweep;

  say(" c) one instance only (api-2 stopped), c=64");
  stack.compose(["stop", "api-2"]);
  await sleep(1000);
  stack.resetData();
  const cpu1 = sampleDockerCpu(stack.project);
  const single = await closedLoop({
    concurrency: 64,
    warmupMs: 3000,
    durationMs: 15_000,
    request: submitter(stack),
  });
  say(row(single));
  result.oneInstance = { ...single, cpu: await cpu1.stop() };
  stack.compose(["start", "api-2"]);
  await stack.waitReady();
  await sleep(12_000); // passive health: NGINX re-admits a recovered instance after fail_timeout (10 s)
  return result;
}

interface DrainConfig {
  workers: number;
  concurrency: number;
  handlerMs: number;
  jobs: number;
}

/** Job completion throughput for different worker counts, concurrency settings and job lengths. */
export async function drainScenario(stack: Stack) {
  const matrix: DrainConfig[] = [
    { workers: 1, concurrency: 1, handlerMs: 25, jobs: 300 },
    { workers: 1, concurrency: 8, handlerMs: 25, jobs: 1500 },
    { workers: 1, concurrency: 32, handlerMs: 25, jobs: 3000 },
    { workers: 2, concurrency: 32, handlerMs: 25, jobs: 3000 },
    { workers: 4, concurrency: 32, handlerMs: 25, jobs: 3000 },
    { workers: 1, concurrency: 32, handlerMs: 0, jobs: 3000 },
    { workers: 2, concurrency: 32, handlerMs: 0, jobs: 3000 },
    { workers: 4, concurrency: 32, handlerMs: 0, jobs: 3000 },
    { workers: 8, concurrency: 32, handlerMs: 0, jobs: 3000 },
  ];
  say(
    "\n[drain] a backlog is enqueued first, then workers start; throughput = jobs / (last finish - first start)",
  );
  const results: unknown[] = [];
  for (const cfg of matrix) {
    stack.resetData();
    await seed(stack, cfg.jobs, () => ({ ms: cfg.handlerMs }));
    const cpu = sampleDockerCpu(stack.project);
    const procs: WorkerProc[] = Array.from({ length: cfg.workers }, () =>
      startWorker(stack, cfg.concurrency),
    );
    try {
      await until(
        `${cfg.jobs} jobs to succeed`,
        180_000,
        () => stack.sqlNumber("SELECT count(*) FROM jobs WHERE status = 'succeeded';") >= cfg.jobs,
      );
    } finally {
      procs.forEach((p) => p.kill());
    }
    const cpuUse = await cpu.stop();
    const spanS = stack.sqlNumber(
      "SELECT extract(epoch FROM (max(finished_at) - min(started_at))) FROM jobs;",
    );
    const [wait] = stack.sql(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (started_at - scheduled_for)) * 1000),
              percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (started_at - scheduled_for)) * 1000),
              percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM (started_at - scheduled_for)) * 1000) FROM jobs;`,
    );
    const [exec] = stack.sql(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (finished_at - started_at)) * 1000),
              percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (finished_at - started_at)) * 1000),
              percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM (finished_at - started_at)) * 1000)
       FROM job_attempts WHERE outcome = 'succeeded';`,
    );
    const attempts = stack.sqlNumber("SELECT count(*) FROM job_attempts;");
    const slots = cfg.workers * cfg.concurrency;
    const ideal = cfg.handlerMs > 0 ? slots / (cfg.handlerMs / 1000) : null;
    const throughput = cfg.jobs / spanS;
    const entry = {
      ...cfg,
      slots,
      spanS: Number(spanS.toFixed(2)),
      throughputPerS: Number(throughput.toFixed(1)),
      idealPerS: ideal,
      slotUtilization: ideal ? Number((throughput / ideal).toFixed(2)) : null,
      attemptsPerJob: Number((attempts / cfg.jobs).toFixed(3)),
      queueWaitMs: { p50: Number(wait?.[0]), p95: Number(wait?.[1]), p99: Number(wait?.[2]) },
      executionMs: { p50: Number(exec?.[0]), p95: Number(exec?.[1]), p99: Number(exec?.[2]) },
      cpu: cpuUse,
    };
    results.push(entry);
    say(
      `  workers=${cfg.workers} conc=${String(cfg.concurrency).padEnd(2)} work=${String(cfg.handlerMs).padStart(2)}ms  ${fmt(throughput, 0).padStart(5)} jobs/s` +
        (ideal ? ` (ideal ${fmt(ideal, 0)}, ${fmt((throughput / ideal) * 100, 0)}% of it)` : "") +
        `  api cpu ${fmt((cpuUse["api-1"]?.meanCores ?? 0) + (cpuUse["api-2"]?.meanCores ?? 0), 2)} cores  postgres ${fmt(cpuUse.postgres?.meanCores ?? 0, 2)} cores  attempts/job ${entry.attemptsPerJob}`,
    );
  }
  return results;
}

/** What a deep backlog costs: submit latency, claim latency, the metrics query, and the drain. */
export async function backlogScenario(stack: Stack) {
  const TOTAL = 20_000;
  say(`\n[backlog] ${TOTAL} jobs enqueued with no workers running`);
  stack.resetData();
  const t0 = performance.now();
  const { latencies, statuses } = await countedLoop(
    TOTAL,
    64,
    submitter(stack, () => ({ ms: 0 })),
  );
  const seedS = (performance.now() - t0) / 1000;
  if (statuses.some((s) => s !== 201)) throw new Error("backlog seeding had failures");
  const early = summarize(latencies.slice(500, 2500));
  const late = summarize(latencies.slice(TOTAL - 2000));
  say(
    `  submit at depth ~0-2.5k: p50 ${early.p50Ms} p95 ${early.p95Ms} p99 ${early.p99Ms} ms | at depth ~18-20k: p50 ${late.p50Ms} p95 ${late.p95Ms} p99 ${late.p99Ms} ms (${fmt(TOTAL / seedS, 0)} jobs/s overall)`,
  );

  // Claim latency at depth: one registered worker claims 10 at a time, 100 times, then completes them.
  const reg = await stack.post("/workers", stack.workerKey, {
    name: "bench-claimer",
    jobTypes: ["bench.job"],
    concurrency: 100,
  });
  const workerId = reg.body.id as string;
  const claimLat: number[] = [];
  const claimed: Array<{ id: string; attemptCount: number }> = [];
  for (let i = 0; i < 100; i++) {
    const c0 = performance.now();
    const r = await stack.post(`/workers/${workerId}/claim`, stack.workerKey, { limit: 10 });
    claimLat.push(performance.now() - c0);
    claimed.push(...(r.body.jobs as Array<{ id: string; attemptCount: number }>));
  }
  const claim = summarize(claimLat);
  say(
    `  claim (limit 10) with ~${TOTAL - 1000}+ queued: p50 ${claim.p50Ms} p95 ${claim.p95Ms} p99 ${claim.p99Ms} ms`,
  );

  const metricsLat: number[] = [];
  let oldest = NaN;
  for (let i = 0; i < 20; i++) {
    const m0 = performance.now();
    const res = await fetch(`${stack.url}/ops/metrics`, {
      headers: { authorization: `Bearer ${VIEWER_KEY}` },
    });
    const text = await res.text();
    metricsLat.push(performance.now() - m0);
    if (i === 0)
      oldest = Number(/workmesh_queue_oldest_ready_age_seconds ([0-9.]+)/.exec(text)?.[1]);
  }
  const metrics = summarize(metricsLat);
  say(
    `  GET /ops/metrics: p50 ${metrics.p50Ms} p95 ${metrics.p95Ms} ms; oldest ready job ${fmt(oldest, 1)} s`,
  );

  await countedLoop(
    claimed.length,
    32,
    async (i) =>
      (
        await stack.post(`/jobs/${claimed[i]!.id}/complete`, stack.workerKey, {
          workerId,
          attempt: claimed[i]!.attemptCount,
        })
      ).status,
  );

  const cpu = sampleDockerCpu(stack.project);
  const procs = [startWorker(stack, 32), startWorker(stack, 32)];
  let drained: number;
  try {
    drained = await until(
      "the backlog to drain",
      300_000,
      () => stack.sqlNumber("SELECT count(*) FROM jobs WHERE status = 'succeeded';") >= TOTAL,
      1000,
    );
  } finally {
    procs.forEach((p) => p.kill());
  }
  const spanS = stack.sqlNumber(
    "SELECT extract(epoch FROM (max(finished_at) - min(started_at))) FROM jobs;",
  );
  const cpuUse = await cpu.stop();
  say(
    `  drain with 2 workers x 32: ${TOTAL} jobs in ${fmt(spanS, 1)} s (${fmt(TOTAL / spanS, 0)} jobs/s)`,
  );
  return {
    total: TOTAL,
    seedSeconds: Number(seedS.toFixed(1)),
    submitEarly: early,
    submitLate: late,
    claimAtDepth: claim,
    metricsQuery: metrics,
    oldestReadyAgeSeconds: oldest,
    drainSpanSeconds: Number(spanS.toFixed(1)),
    drainPerS: Number((TOTAL / spanS).toFixed(0)),
    observedWaitMs: drained,
    cpu: cpuUse,
  };
}

// ============================================================================== FAILURES
/** Kill an API instance in the middle of POST /jobs traffic. A client retries once on failure. */
export async function instanceLossScenario(stack: Stack, keyed = false) {
  say(
    `\n[instance-loss${keyed ? "-keyed" : ""}] POST /jobs under load; api-2 is SIGKILLed at 8 s and restarted at 16 s`,
  );
  if (keyed) {
    say("  Every submission carries an Idempotency-Key, so the client's one retry is safe.");
    say("  EXPECTED: the same few first-try failures as without keys, but ZERO duplicate jobs.");
  }
  say(
    "  EXPECTED: the gateway retries connection failures on api-1, so almost no client error; a request",
  );
  say(
    "  that was already running on api-2 at the kill may fail; a client that retries it can create a DUPLICATE",
  );
  say("  (POST /jobs has no idempotency key). Nothing acknowledged may be lost.");
  stack.resetData();
  const intents = new Map<
    number,
    { firstStatus: number | string; acked: boolean; tries: number }
  >();
  const post = submitter(stack, () => ({}), keyed ? (n) => `bench-${n}` : undefined);
  const t0 = performance.now();
  const timeline: Array<{ atS: number; event: string }> = [];
  const mark = (event: string): void =>
    void timeline.push({ atS: Number(((performance.now() - t0) / 1000).toFixed(2)), event });
  const failuresAtS: number[] = [];

  // Asynchronous on purpose: the load lanes must keep sending while the fault is injected.
  setTimeout(() => {
    mark("docker kill api-2");
    void stack.composeAsync(["kill", "api-2"]);
  }, 8000);
  setTimeout(() => {
    mark("docker start api-2");
    void stack.composeAsync(["start", "api-2"]);
  }, 16_000);

  const run = await closedLoop({
    concurrency: 16,
    warmupMs: 0,
    durationMs: 26_000,
    request: async (n) => {
      let status: number | string = "?";
      let tries = 0;
      const intent = { firstStatus: "?" as number | string, acked: false, tries: 0 };
      intents.set(n, intent);
      for (; tries < 2; tries++) {
        try {
          status = await post(n);
        } catch (error) {
          status = `error:${(error as Error).name}`;
        }
        if (tries === 0) intent.firstStatus = status;
        if (status === 201 || status === 200) break;
        failuresAtS.push(Number(((performance.now() - t0) / 1000).toFixed(2)));
        await sleep(100);
      }
      intent.tries = tries + 1;
      intent.acked = status === 201 || status === 200;
      return status;
    },
  });

  const perN = new Map<number, number>();
  for (const [n, count] of stack
    .sql("SELECT payload->>'n', count(*) FROM jobs GROUP BY 1;")
    .map((r) => [Number(r[0]), Number(r[1])] as const))
    perN.set(n, count);
  let duplicates = 0;
  let lost = 0;
  let unackedButPresent = 0;
  let firstTryFailures = 0;
  for (const [n, intent] of intents) {
    const rows = perN.get(n) ?? 0;
    if (intent.firstStatus !== 201) firstTryFailures++;
    if (rows > 1) duplicates++;
    if (intent.acked && rows === 0) lost++;
    if (!intent.acked && rows > 0) unackedButPresent++;
  }
  const finalFailures = [...intents.values()].filter((i) => !i.acked).length;
  const outcome = {
    intents: intents.size,
    acknowledged: [...intents.values()].filter((i) => i.acked).length,
    firstTryFailures,
    finalFailures,
    duplicateJobs: duplicates,
    acknowledgedButLost: lost,
    unacknowledgedButCreated: unackedButPresent,
    firstFailureTimes: failuresAtS.slice(0, 10),
    latencyOk: run.latencyOk,
    byStatusFinal: run.byStatus,
    timeline,
  };
  say(
    `  OBSERVED: ${outcome.intents} submissions, ${outcome.firstTryFailures} first-try failures, ${outcome.finalFailures} still failing after one retry`,
  );
  say(
    `            duplicate jobs ${duplicates}, acknowledged-but-lost ${lost}, failed-but-created ${unackedButPresent}`,
  );
  await stack.waitReady();
  await sleep(11_000);
  return outcome;
}

/** SIGKILL a worker that holds running jobs; another worker must finish them. */
export async function workerCrashScenario(stack: Stack, leaseMs: number, reaperMs: number) {
  say(
    `\n[worker-crash] 10 jobs of 4 s; worker A (5 slots) is SIGKILLed mid-job; lease ${leaseMs} ms, reaper every ${reaperMs} ms`,
  );
  say(
    `  EXPECTED: A's 5 running jobs stay 'running' until their lease expires, then the reaper re-queues them`,
  );
  say(
    `  (recovery between about ${(leaseMs * 2) / 3 / 1000} s and ${(leaseMs + reaperMs) / 1000} s after the kill), worker B runs them as attempt 2, none is lost.`,
  );
  stack.resetData();
  await seed(stack, 10, () => ({ ms: 4000 }));
  const offset = clockOffsetMs(stack);
  const a = startWorker(stack, 5);
  await until(
    "5 jobs running",
    60_000,
    () => stack.sqlNumber("SELECT count(*) FROM jobs WHERE status = 'running';") >= 5,
    200,
  );
  await sleep(1500);
  const killedAtHost = Date.now();
  killProc(a.proc.pid!);
  const b = startWorker(stack, 5);
  const recoveredMs = await until(
    "all 10 jobs to succeed",
    120_000,
    () => stack.sqlNumber("SELECT count(*) FROM jobs WHERE status = 'succeeded';") >= 10,
    250,
  );
  b.kill();
  const killedAtDb = (killedAtHost + offset) / 1000;
  const expired = stack
    .sql(
      "SELECT extract(epoch FROM finished_at) FROM job_attempts WHERE outcome = 'lease_expired' ORDER BY 1;",
    )
    .map((r) => Number((Number(r[0]) - killedAtDb).toFixed(2)));
  const finishedAfterKill = stack
    .sql("SELECT extract(epoch FROM finished_at) FROM jobs ORDER BY 1;")
    .map((r) => Number((Number(r[0]) - killedAtDb).toFixed(2)));
  const attemptsPerJob = stack
    .sql("SELECT attempt_count, count(*) FROM jobs GROUP BY 1 ORDER BY 1;")
    .map((r) => ({ attempts: Number(r[0]), jobs: Number(r[1]) }));
  const succeeded = stack.sqlNumber("SELECT count(*) FROM jobs WHERE status = 'succeeded';");
  const outcome = {
    jobs: 10,
    succeeded,
    leaseMs,
    reaperMs,
    clockOffsetMs: offset,
    secondsAfterKill: { leaseExpiredRecorded: expired, jobsFinished: finishedAfterKill },
    attemptsPerJob,
    waitedMs: recoveredMs,
  };
  say(
    `  OBSERVED: ${succeeded}/10 succeeded; lease_expired recorded at +${expired.join(", +")} s after the kill; last job finished at +${finishedAfterKill.at(-1)} s`,
  );
  say(
    `            attempts per job: ${attemptsPerJob.map((a) => `${a.jobs} jobs x ${a.attempts}`).join(", ")}`,
  );
  return outcome;
}

/** Stop PostgreSQL for ~12 s while traffic flows, then start it again. */
export async function dbDownScenario(stack: Stack) {
  say(
    "\n[db-down] steady POST /jobs traffic + a worker; PostgreSQL stopped for ~12 s, then started",
  );
  say(
    "  EXPECTED: submissions fail fast with an error while it is down (nothing is acknowledged that is not stored),",
  );
  say(
    "  the API processes stay up and recover by themselves when the database returns, acknowledged jobs all run.",
  );
  stack.resetData();
  const worker = startWorker(stack, 8);
  const post = submitter(stack, () => ({ ms: 20 }));
  const t0 = performance.now();
  const buckets = new Map<number, Record<string, number>>();
  const acked = new Set<number>();
  const okLatencies: number[] = [];
  const failLatencies: number[] = [];
  const events: Array<{ atS: number; event: string }> = [];
  const nowS = (): number => (performance.now() - t0) / 1000;
  const mark = (event: string): void => void events.push({ atS: Number(nowS().toFixed(2)), event });

  const ready: Array<{ atS: number; status: number | string }> = [];
  let polling = true;
  const poller = (async () => {
    while (polling) {
      let status: number | string;
      try {
        status = (await fetch(`${stack.url}/readyz`)).status;
      } catch (error) {
        status = `error:${(error as Error).name}`;
      }
      ready.push({ atS: Number(nowS().toFixed(1)), status });
      await sleep(1000);
    }
  })();

  let stopIssued = 0;
  let startIssued = 0;
  setTimeout(() => {
    mark("docker stop postgres");
    stopIssued = nowS();
    void stack.composeAsync(["stop", "postgres"]).then(() => mark("postgres stopped"));
    setTimeout(() => {
      mark("docker start postgres");
      startIssued = nowS();
      void stack.composeAsync(["start", "postgres"]).then(() => mark("start returned"));
    }, 10_000);
  }, 5000);

  await closedLoop({
    concurrency: 4,
    warmupMs: 0,
    durationMs: 40_000,
    request: async (n) => {
      await sleep(50);
      let status: number | string;
      const r0 = performance.now();
      try {
        status = await post(n);
      } catch (error) {
        status = `error:${(error as Error).name}`;
      }
      const took = performance.now() - r0;
      (status === 201 ? okLatencies : failLatencies).push(took);
      const sec = Math.floor(nowS());
      const b = buckets.get(sec) ?? {};
      b[String(status)] = (b[String(status)] ?? 0) + 1;
      buckets.set(sec, b);
      if (status === 201) acked.add(n);
      return status;
    },
  });
  polling = false;
  await poller;

  const perSecond = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([sec, counts]): { sec: number } & Record<string, number> => ({ ...counts, sec }));
  const firstOkAfterStart = perSecond.find(
    (s) => s.sec >= Math.floor(startIssued) && (s["201"] ?? 0) > 0,
  )?.sec;
  const inspect = (service: string) => {
    const r = spawnSync(
      "docker",
      [
        "inspect",
        "--format",
        "{{.State.Status}}|{{.RestartCount}}|{{.State.ExitCode}}",
        stack.container(service),
      ],
      { encoding: "utf8" },
    );
    const [state, restarts, exit] = r.stdout.trim().split("|");
    return { state, restarts: Number(restarts), exitCode: Number(exit) };
  };
  const apiState = { "api-1": inspect("api-1"), "api-2": inspect("api-2") };

  let drained = true;
  try {
    await until(
      "acknowledged jobs to finish",
      90_000,
      () =>
        stack.sqlNumber("SELECT count(*) FROM jobs WHERE status IN ('succeeded','failed');") >=
        acked.size,
      1000,
    );
  } catch {
    drained = false;
  }
  worker.kill();
  const present = new Set(
    stack.sql("SELECT DISTINCT (payload->>'n') FROM jobs;").map((r) => Number(r[0])),
  );
  const lost = [...acked].filter((n) => !present.has(n)).length;
  const finalStatus = stack
    .sql("SELECT status, count(*) FROM jobs GROUP BY 1 ORDER BY 1;")
    .map((r) => `${r[0]}:${r[1]}`)
    .join(" ");
  const outcome = {
    events,
    apiState,
    acknowledged: acked.size,
    acknowledgedButLost: lost,
    firstSuccessfulSubmitSecond: firstOkAfterStart,
    databaseStartIssuedAtS: Number(startIssued.toFixed(1)),
    databaseStopIssuedAtS: Number(stopIssued.toFixed(1)),
    successLatency: summarize(okLatencies),
    failureLatency: summarize(failLatencies),
    failedRequests: failLatencies.length,
    allAcknowledgedJobsFinished: drained,
    finalJobStatuses: finalStatus,
    perSecond,
    readyz: ready,
  };
  say(
    `  OBSERVED: api-1 ${JSON.stringify(apiState["api-1"])}  api-2 ${JSON.stringify(apiState["api-2"])}`,
  );
  say(
    `            acknowledged ${acked.size}, acknowledged-but-lost ${lost}; first 201 at t=${firstOkAfterStart}s (start issued at ${fmt(startIssued)}s); final ${finalStatus}`,
  );
  say(
    `            failed requests ${failLatencies.length}: took p50 ${summarize(failLatencies).p50Ms} ms, p95 ${summarize(failLatencies).p95Ms} ms, max ${summarize(failLatencies).maxMs} ms`,
  );
  say(
    `            per second (t: statuses): ${perSecond
      .filter((s) => s.sec >= 4 && s.sec <= 24)
      .map(
        (s) =>
          `${s.sec}:${Object.entries(s)
            .filter(([k]) => k !== "sec")
            .map(([k, v]) => `${k}x${v}`)
            .join("/")}`,
      )
      .join("  ")}`,
  );
  return outcome;
}

/** 1,000 jobs that always fail: do the retries come back as one spike or spread out by jitter? */
export async function retryStormScenario(stack: Stack, retryBaseMs: number) {
  const JOBS = 1000;
  say(`\n[retry-storm] ${JOBS} jobs that always fail, maxAttempts 4, retry base ${retryBaseMs} ms`);
  say(
    `  EXPECTED: delays are min(cap, base x 2^(attempt-1)) x uniform(0.5, 1): about ${retryBaseMs * 0.5}-${retryBaseMs} ms, then ${retryBaseMs}-${retryBaseMs * 2} ms, then ${retryBaseMs * 2}-${retryBaseMs * 4} ms,`,
  );
  say(
    `  so each retry wave is smeared over about half its delay instead of landing in one second; every job ends 'failed' after 4 attempts.`,
  );
  stack.resetData();
  await seed(stack, JOBS, () => ({ fail: true }));
  // Rewrite budgets to 4 attempts (the default is 3) so three retry waves are visible.
  stack.sql("UPDATE jobs SET max_attempts = 4;");
  const procs = [startWorker(stack, 32), startWorker(stack, 32)];
  try {
    await until(
      "all jobs terminal",
      180_000,
      () => stack.sqlNumber("SELECT count(*) FROM jobs WHERE status = 'failed';") >= JOBS,
      500,
    );
  } finally {
    procs.forEach((p) => p.kill());
  }
  const series = stack
    .sql(
      `SELECT attempt_number, floor(extract(epoch FROM started_at) - (SELECT min(extract(epoch FROM started_at)) FROM job_attempts))::int AS sec, count(*)
       FROM job_attempts GROUP BY 1, 2 ORDER BY 1, 2;`,
    )
    .map((r) => ({ attempt: Number(r[0]), sec: Number(r[1]), starts: Number(r[2]) }));
  const perAttempt = [1, 2, 3, 4].map((attempt) => {
    const rows = series.filter((s) => s.attempt === attempt);
    return {
      attempt,
      total: rows.reduce((a, b) => a + b.starts, 0),
      firstSec: rows[0]?.sec,
      lastSec: rows.at(-1)?.sec,
      peakPerSecond: Math.max(0, ...rows.map((r) => r.starts)),
      secondsUsed: rows.length,
    };
  });
  const failed = stack.sqlNumber(
    "SELECT count(*) FROM jobs WHERE status = 'failed' AND attempt_count = 4;",
  );
  const overallPeak = Math.max(...series.map((s) => s.starts));
  say(`  OBSERVED: ${failed}/${JOBS} ended failed after exactly 4 attempts`);
  for (const a of perAttempt)
    say(
      `            attempt ${a.attempt}: ${a.total} starts between t=${a.firstSec}s and t=${a.lastSec}s, busiest second ${a.peakPerSecond}`,
    );
  say(
    `            busiest second overall: ${overallPeak} attempt starts (a no-jitter retry wave would put ~${JOBS} in one second)`,
  );
  return {
    jobs: JOBS,
    retryBaseMs,
    endedFailedAfterFourAttempts: failed,
    perAttempt,
    perSecond: series,
  };
}

// ================================================================================ TUNING
/** How repeatable is one number? The same experiment, run several times back to back. */
export async function noiseScenario(stack: Stack) {
  say(
    "[noise] the same submit experiment (c=64, 15 s) repeated, to see how much a single number varies",
  );
  const runs: LoadResult[] = [];
  for (let i = 0; i < 4; i++) {
    stack.resetData();
    const r = await closedLoop({
      concurrency: 64,
      warmupMs: 3000,
      durationMs: 15_000,
      request: submitter(stack),
    });
    say(row(r));
    runs.push(r);
  }
  const t = runs.map((r) => r.throughputPerS);
  const mean = t.reduce((a, b) => a + b, 0) / t.length;
  const spreadPct = ((Math.max(...t) - Math.min(...t)) / mean) * 100;
  say(`  mean ${fmt(mean, 0)}/s, min-to-max spread ${fmt(spreadPct)}% of the mean`);
  return { runs, meanPerS: Number(mean.toFixed(1)), spreadPct: Number(spreadPct.toFixed(1)) };
}

/** Is the API's connection pool the completion bottleneck? Same drain, different pool sizes. */
export async function poolScenario(stack: Stack) {
  say(
    "[pool] drain 3000 zero-work jobs with 4 workers x 32 slots; only DB_POOL_MAX (per API instance) changes",
  );
  const out: unknown[] = [];
  for (const pool of [3, 5, 10, 20, 40]) {
    await stack.setApiEnv({ DB_POOL_MAX: String(pool) });
    stack.resetData();
    await seed(stack, 3000, () => ({ ms: 0 }));
    const cpu = sampleDockerCpu(stack.project);
    const procs = Array.from({ length: 4 }, () => startWorker(stack, 32));
    let states: Array<{ state: string; count: number }> = [];
    try {
      await until(
        "3000 jobs to succeed",
        180_000,
        () => {
          const done = stack.sqlNumber("SELECT count(*) FROM jobs WHERE status = 'succeeded';");
          if (states.length === 0 && done > 600) {
            states = stack
              .sql(
                "SELECT coalesce(state, 'none'), count(*) FROM pg_stat_activity WHERE datname = 'workmesh' AND pid <> pg_backend_pid() GROUP BY 1 ORDER BY 1;",
              )
              .map((r) => ({ state: r[0]!, count: Number(r[1]) }));
          }
          return done >= 3000;
        },
        300,
      );
    } finally {
      procs.forEach((p) => p.kill());
    }
    const cpuUse = await cpu.stop();
    const spanS = stack.sqlNumber(
      "SELECT extract(epoch FROM (max(finished_at) - min(started_at))) FROM jobs;",
    );
    const entry = {
      dbPoolMaxPerInstance: pool,
      throughputPerS: Number((3000 / spanS).toFixed(0)),
      spanS: Number(spanS.toFixed(2)),
      connectionStatesMidRun: states,
      cpu: cpuUse,
    };
    out.push(entry);
    say(
      `  pool ${String(pool).padStart(2)}/instance: ${fmt(3000 / spanS, 0).padStart(5)} jobs/s   pg connections mid-run: ${states.map((s) => `${s.state}=${s.count}`).join(" ")}   api cpu ${fmt((cpuUse["api-1"]?.meanCores ?? 0) + (cpuUse["api-2"]?.meanCores ?? 0), 2)} postgres ${fmt(cpuUse.postgres?.meanCores ?? 0, 2)}`,
    );
  }
  await stack.setApiEnv({ DB_POOL_MAX: "10" });
  return out;
}

/**
 * A/B harness for one optimization at a time: the same two experiments repeated five times, so a
 * difference can be judged against the run-to-run spread. Run it once per build and compare.
 */
export async function abScenario(stack: Stack) {
  const REPEATS = 5;
  say(
    `[ab] ${REPEATS} x submit (c=64, 10 s) and ${REPEATS} x drain (3000 zero-work jobs, 4 workers x 32)`,
  );
  const submit: number[] = [];
  for (let i = 0; i < REPEATS; i++) {
    stack.resetData();
    const r = await closedLoop({
      concurrency: 64,
      warmupMs: 2000,
      durationMs: 10_000,
      request: submitter(stack),
    });
    submit.push(r.throughputPerS);
  }
  const drain: number[] = [];
  for (let i = 0; i < REPEATS; i++) {
    stack.resetData();
    await seed(stack, 3000, () => ({ ms: 0 }));
    const procs = Array.from({ length: 4 }, () => startWorker(stack, 32));
    try {
      await until(
        "3000 jobs to succeed",
        180_000,
        () => stack.sqlNumber("SELECT count(*) FROM jobs WHERE status = 'succeeded';") >= 3000,
        300,
      );
    } finally {
      procs.forEach((p) => p.kill());
    }
    drain.push(
      Number(
        (
          3000 /
          stack.sqlNumber(
            "SELECT extract(epoch FROM (max(finished_at) - min(started_at))) FROM jobs;",
          )
        ).toFixed(0),
      ),
    );
  }
  const stats = (xs: number[]) => {
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    return {
      runs: xs,
      mean: Number(mean.toFixed(0)),
      min: Math.min(...xs),
      max: Math.max(...xs),
      spreadPct: Number((((Math.max(...xs) - Math.min(...xs)) / mean) * 100).toFixed(1)),
    };
  };
  const result = { submitPerS: stats(submit), drainPerS: stats(drain) };
  say(
    `  submit  mean ${result.submitPerS.mean}/s  [${submit.join(", ")}]  spread ${result.submitPerS.spreadPct}%`,
  );
  say(
    `  drain   mean ${result.drainPerS.mean}/s  [${drain.join(", ")}]  spread ${result.drainPerS.spreadPct}%`,
  );
  return result;
}
