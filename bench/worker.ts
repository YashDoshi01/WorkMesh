// The benchmark's worker process: the real SDK, with one handler whose behaviour comes from the
// job's payload, so every scenario uses the same worker.
//   payload.ms   : how long the "work" takes (default 0)
//   payload.fail : true => throw (retryable)
import { Worker } from "@workmesh/worker-sdk";

const apiKey = process.env.WORKMESH_API_KEY;
const worker = new Worker({
  apiUrl: process.env.WORKMESH_API_URL ?? "http://localhost:8080",
  ...(apiKey ? { apiKey } : {}),
  name: `bench-${process.pid}`,
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 8),
  pollIntervalMs: 50,
  log: () => undefined,
});

worker.register("bench.job", async (job) => {
  const ms = Number(job.payload.ms ?? 0);
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  if (job.payload.fail === true) throw new Error("bench: planned failure");
});

await worker.start();
process.on("SIGTERM", () => void worker.stop().then(() => process.exit(0)));
