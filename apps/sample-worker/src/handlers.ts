import { link, mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

interface JobLike {
  id: string;
  payload: Record<string, unknown>;
}

/**
 * An IDEMPOTENT handler: running it twice for the same job has the same effect as running
 * it once. Delivery is at-least-once (a crash or a lost acknowledgement makes WorkMesh run
 * a job again), so a handler with an external side effect must make that effect safe to repeat.
 *
 * The technique: derive a deterministic key from the job id (stable across attempts) and make
 * "create the effect for this key" atomic. Here the effect is a file named after the job id,
 * published with link(2), which fails with EEXIST if the file already exists. Content is written
 * to a private temp file first, so a crash mid-write can never leave a half-written invoice
 * under the real name.
 *
 * Returns "created" the first time and "duplicate" on any repeat.
 */
export async function generateInvoice(
  job: JobLike,
  outDir: string,
): Promise<"created" | "duplicate"> {
  const customer = job.payload.customer;
  const amountCents = job.payload.amountCents;
  if (typeof customer !== "string" || !Number.isInteger(amountCents)) {
    throw new Error("payload needs customer (string) and amountCents (integer)");
  }
  await mkdir(outDir, { recursive: true });
  const finalPath = path.join(outDir, `${job.id}.txt`);
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, `invoice for ${customer}: ${String(amountCents)} cents\n`, {
    flag: "wx",
  });
  try {
    await link(tmpPath, finalPath);
    return "created";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return "duplicate";
    throw err;
  } finally {
    await unlink(tmpPath).catch(() => undefined);
  }
}

/** Waits `payload.ms` (default 1000, max 60 s), stopping early if the lease is lost. */
export async function slowTask(job: JobLike, signal: AbortSignal): Promise<void> {
  const ms = Math.min(Number(job.payload.ms ?? 1000), 60_000);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted: lease lost"));
      },
      { once: true },
    );
  });
}
