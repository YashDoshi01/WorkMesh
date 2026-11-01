import { CronExpressionParser } from "cron-parser";

/**
 * Cron arithmetic, isolated so the rest of the code never touches the library.
 *
 * Semantics (pinned by tests/unit/cron.test.ts, not assumed):
 *  - Exactly five fields: minute hour day-of-month month day-of-week. Seconds and
 *    macros like @daily are rejected, which also bounds the rate to one job a minute.
 *  - Evaluated in the schedule's IANA time zone, results are absolute instants (UTC).
 *  - A wall-clock time that does not exist (02:30 on spring-forward day) fires once,
 *    shifted forward (03:30 local). An ambiguous time (01:30 on fall-back day) fires once,
 *    at its first occurrence. An "every hour" schedule fires every real hour.
 */

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Returns a human-readable problem, or null if the expression and zone are usable. */
export function describeScheduleProblem(cron: string, timeZone: string): string | null {
  if (cron.trim().split(/\s+/).length !== 5) {
    return "cron must have exactly 5 fields: minute hour day-of-month month day-of-week";
  }
  if (!isValidTimeZone(timeZone)) {
    return `unknown time zone "${timeZone}" (use an IANA name such as Europe/London)`;
  }
  try {
    nextOccurrenceAfter(cron, timeZone, new Date(0));
  } catch (err) {
    return `invalid cron expression: ${err instanceof Error ? err.message : String(err)}`;
  }
  return null;
}

/** First occurrence strictly after `after`. */
export function nextOccurrenceAfter(cron: string, timeZone: string, after: Date): Date {
  return CronExpressionParser.parse(cron.trim(), { currentDate: after, tz: timeZone })
    .next()
    .toDate();
}

/** Latest occurrence at or before `at` (the library's prev() is strict, so look 1 ms ahead). */
export function latestOccurrenceAtOrBefore(cron: string, timeZone: string, at: Date): Date {
  return CronExpressionParser.parse(cron.trim(), {
    currentDate: new Date(at.getTime() + 1),
    tz: timeZone,
  })
    .prev()
    .toDate();
}
