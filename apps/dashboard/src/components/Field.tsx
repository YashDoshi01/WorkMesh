import { useId, type InputHTMLAttributes, type ReactNode } from "react";
import { ApiError } from "../api/client";

/** A labelled input with a hint and an error message wired up for screen readers. */
export function Field({
  label,
  hint,
  error,
  children,
  ...input
}: {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  children?: ReactNode;
} & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : "", error ? errorId : ""].filter(Boolean).join(" ");
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        {...input}
      />
      {children}
      {hint ? (
        <span id={hintId} className="hint">
          {hint}
        </span>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The server's per-field problems, keyed by field name, plus a general message if there are none. */
export function problems(err: unknown): { fields: Record<string, string>; general: string | null } {
  if (err instanceof ApiError) {
    const fields: Record<string, string> = {};
    for (const d of err.details) fields[d.path] ??= d.message;
    return { fields, general: Object.keys(fields).length > 0 ? null : err.message };
  }
  return { fields: {}, general: "Something went wrong. Please try again." };
}
