import type { ZodType } from "zod";
import { HttpError } from "./errors.js";

/** Runtime-validates untrusted input; failures become a 400 with per-field details. */
export function parse<T>(schema: ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new HttpError(
    400,
    "validation_error",
    `Invalid ${what}`,
    result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  );
}
