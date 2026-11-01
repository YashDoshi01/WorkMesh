/**
 * Log redaction. Applied to EVERY log line before it is written (see logger.ts), so a careless
 * `logInfo("x", { headers })` somewhere cannot put a credential or a customer payload into the logs.
 *
 * Two independent defences, because each has blind spots:
 *  1. by FIELD NAME: anything called authorization, apiKey, secret, password, token, ... or
 *     `payload` is replaced wholesale (a payload is customer data and can hold anything).
 *  2. by VALUE SHAPE: a string that looks like a WorkMesh key (wm_xxxxxxxx_<43 chars>) or a
 *     Bearer credential is masked even inside a free-text message or an unexpected field.
 *
 * It is a safety net, not a licence to log secrets: the first rule is still never to pass them.
 */
const SENSITIVE_NAME =
  /^(authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|apikey|x-api-key|secret[-_]?hash|payload|operator_api_key|viewer_api_key|database_url)$|password|passwd|secret|token/i;

const KEY_VALUE = /wm_[a-f0-9]{8}_[A-Za-z0-9_-]{43}/g;
const BEARER_VALUE = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
// Credentials embedded in a connection string: postgres://user:password@host
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi;

export const REDACTED = "[redacted]";
const MAX_DEPTH = 6;

export function redactString(value: string): string {
  return value
    .replace(KEY_VALUE, REDACTED)
    .replace(BEARER_VALUE, `$1 ${REDACTED}`)
    .replace(URL_CREDENTIALS, `$1:${REDACTED}@`);
}

export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(value)) {
    out[name] = SENSITIVE_NAME.test(name) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}
