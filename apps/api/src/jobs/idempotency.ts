import { createHash } from "node:crypto";
import type { CreateJobInput } from "./schema.js";

/** What a client may send as an Idempotency-Key; mirrors the CHECK constraint. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** JSON with object keys sorted, so two requests that mean the same thing serialize identically. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * A fingerprint of a job submission, taken AFTER validation (so defaults are filled in): a repeat
 * of the same request has the same hash whatever the order of its JSON keys, and a request that
 * differs in any way (type, payload, priority, attempts, run time) does not.
 */
export function requestHash(input: CreateJobInput): Buffer {
  return createHash("sha256")
    .update(
      stableStringify({
        type: input.type,
        payload: input.payload,
        priority: input.priority,
        maxAttempts: input.maxAttempts,
        runAt: input.runAt ?? null,
      }),
    )
    .digest();
}

/** The same key was used for a request that is not the same request. */
export class IdempotencyConflictError extends Error {}
