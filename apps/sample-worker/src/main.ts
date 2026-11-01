// Example of a *customer-owned* worker application. The handlers below are the
// customer's code; WorkMesh only stores job metadata and payloads, never this code.
import { PermanentError, Worker } from "@workmesh/worker-sdk";
import { generateInvoice, slowTask } from "./handlers.js";

const worker = new Worker({
  apiUrl: process.env.WORKMESH_API_URL ?? "http://localhost:3000",
  // A `worker` key from an operator (POST /ops/keys). See README, "API keys".
  ...(process.env.WORKMESH_API_KEY ? { apiKey: process.env.WORKMESH_API_KEY } : {}),
  name: process.env.WORKER_NAME ?? "sample-worker",
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
  pollIntervalMs: Number(process.env.WORKER_POLL_MS ?? 1000),
});
const invoiceDir = process.env.INVOICE_DIR ?? "./out/invoices";

// Simulates sending an email. A real handler would call a provider, passing job.id as the
// provider's idempotency key so a repeated run does not send a second email.
worker.register("email.send", async (job) => {
  const to = job.payload.to;
  if (typeof to !== "string") throw new PermanentError("payload.to must be a string");
  await new Promise((resolve) => setTimeout(resolve, 200));
  console.log(JSON.stringify({ msg: "pretend_email_sent", to, jobId: job.id }));
});

// Fails on purpose when payload.shouldFail is true. A plain Error is retried with backoff.
worker.register("report.build", async (job) => {
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (job.payload.shouldFail === true) throw new Error("report generation failed");
});

// Idempotent: safe to run twice for one job (see handlers.ts and docs/IDEMPOTENCY.md).
worker.register("invoice.generate", async (job) => {
  const result = await generateInvoice(job, invoiceDir);
  console.log(JSON.stringify({ msg: "invoice", result, jobId: job.id, attempt: job.attemptCount }));
});

// A long-running job, handy for demonstrating lease renewal and crash recovery.
worker.register("slow.task", (job, ctx) => slowTask(job, ctx.signal));

await worker.start();

async function shutdown(signal: string): Promise<void> {
  console.log(JSON.stringify({ msg: "shutdown_started", signal }));
  await worker.stop();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
