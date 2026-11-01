// Example of a *customer-owned* worker application. The handlers below are the
// customer's code; WorkMesh only stores job metadata and payloads, never this code.
import { Worker } from "@workmesh/worker-sdk";

const worker = new Worker({
  apiUrl: process.env.WORKMESH_API_URL ?? "http://localhost:3000",
  name: process.env.WORKER_NAME ?? "sample-worker",
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
  pollIntervalMs: Number(process.env.WORKER_POLL_MS ?? 1000),
});

// Simulates sending an email. A real handler would call an email provider.
worker.register("email.send", async (job) => {
  const to = job.payload.to;
  if (typeof to !== "string") throw new Error("payload.to must be a string");
  await new Promise((resolve) => setTimeout(resolve, 200));
  console.log(JSON.stringify({ msg: "pretend_email_sent", to, jobId: job.id }));
});

// Fails on purpose when payload.shouldFail is true, to demonstrate failure reporting.
worker.register("report.build", async (job) => {
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (job.payload.shouldFail === true) throw new Error("report generation failed");
});

await worker.start();

async function shutdown(signal: string): Promise<void> {
  console.log(JSON.stringify({ msg: "shutdown_started", signal }));
  await worker.stop();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
