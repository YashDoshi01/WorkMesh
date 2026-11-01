// Benchmark runner.
//
//   npm run bench -- perf        submit, drain, backlog   (default settings)
//   npm run bench -- failure     instance-loss, worker-crash, db-down, retry-storm (short leases)
//   npm run bench -- <one of the scenario names>
//   add --skip-build to reuse the existing API image, --keep to leave the stack running.
//
// It starts its own isolated Docker stack (project workmesh-bench, port 18090), writes raw JSON
// results to bench/results/, and tears the stack down. It never touches the stack you run by hand.
import {
  backlogScenario,
  dbDownScenario,
  drainScenario,
  abScenario,
  instanceLossScenario,
  noiseScenario,
  poolScenario,
  retryStormScenario,
  submitScenario,
  workerCrashScenario,
} from "./scenarios.js";
import { environment, saveResult, Stack } from "./lib.js";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const names = args.filter((a) => !a.startsWith("--"));
if (names.length === 0) {
  console.error(
    "usage: npm run bench -- <perf|failure|submit|drain|backlog|instance-loss|worker-crash|db-down|retry-storm> [--skip-build] [--keep]",
  );
  process.exit(2);
}

const FAST = { LEASE_MS: "6000", REAPER_INTERVAL_MS: "1000", RETRY_BASE_MS: "2000" };
const PERF = new Set(["submit", "drain", "backlog"]);
const TUNING = new Set(["noise", "pool", "ab"]);
const FAILURE = new Set(["instance-loss", "worker-crash", "db-down", "retry-storm"]);

const expanded = names.flatMap((n) =>
  n === "perf" ? [...PERF] : n === "failure" ? [...FAILURE] : [n],
);
for (const n of expanded) {
  if (!PERF.has(n) && !FAILURE.has(n) && !TUNING.has(n)) {
    console.error(`unknown scenario: ${n}`);
    process.exit(2);
  }
}

async function group(scenarioNames: string[], fast: boolean): Promise<void> {
  if (scenarioNames.length === 0) return;
  const stack = new Stack({ limits: "shipped", ...(fast ? { extraEnv: FAST } : {}) });
  console.log(
    `\n=== starting an isolated stack (${fast ? "short leases: lease 6 s, reaper 1 s, retry base 2 s" : "default settings"}) ===`,
  );
  await stack.up(!flags.has("--skip-build"));
  try {
    for (const name of scenarioNames) {
      const started = Date.now();
      let data: unknown;
      if (name === "submit") data = await submitScenario(stack);
      else if (name === "drain") {
        await stack.setLimits("lifted");
        data = await drainScenario(stack);
      } else if (name === "noise") {
        await stack.setLimits("lifted");
        data = await noiseScenario(stack);
      } else if (name === "ab") {
        await stack.setLimits("lifted");
        data = await abScenario(stack);
      } else if (name === "pool") {
        await stack.setLimits("lifted");
        data = await poolScenario(stack);
      } else if (name === "backlog") {
        await stack.setLimits("lifted");
        data = await backlogScenario(stack);
      } else if (name === "instance-loss") {
        await stack.setLimits("lifted");
        data = await instanceLossScenario(stack);
      } else if (name === "worker-crash") data = await workerCrashScenario(stack, 6000, 1000);
      else if (name === "db-down") {
        await stack.setLimits("lifted");
        data = await dbDownScenario(stack);
      } else data = await retryStormScenario(stack, 2000);
      const path = saveResult(name === "ab" ? `ab-${process.env.BENCH_LABEL ?? "run"}` : name, {
        scenario: name,
        environment: environment(),
        stackSettings: fast ? FAST : "defaults",
        wallSeconds: Math.round((Date.now() - started) / 1000),
        result: data,
      });
      console.log(`  raw results: ${path}`);
    }
  } finally {
    if (!flags.has("--keep")) await stack.down();
  }
}

await group(
  expanded.filter((n) => PERF.has(n)),
  false,
);
await group(
  expanded.filter((n) => TUNING.has(n)),
  false,
);
await group(
  expanded.filter((n) => FAILURE.has(n)),
  true,
);
console.log("\ndone.");
