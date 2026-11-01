/**
 * Is this failure about the environment (retry later) rather than about the data being processed?
 *
 *  - PostgreSQL errors carry a 5-character SQLSTATE. Classes 08 (connection), 40 (transaction
 *    rollback: deadlock, serialization), 53 (insufficient resources), 57 (operator
 *    intervention / query cancelled) and 58 (system error) are transient.
 *  - Node network errors carry a non-SQLSTATE code such as ECONNRESET: transient.
 *  - An error with no code (a thrown Error from our own code or a library, e.g. an unparseable
 *    cron expression) or any other SQLSTATE (constraint violation, trigger exception, bad
 *    data) is about the data: retrying the same input would fail the same way.
 */
export function isTransientDbError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return false;
  if (!/^[0-9A-Z]{5}$/.test(code)) return true;
  return ["08", "40", "53", "57", "58"].includes(code.slice(0, 2));
}
