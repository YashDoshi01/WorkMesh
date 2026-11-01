import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Machine API keys look like  wm_<prefix>_<secret>
 *
 *   prefix : 8 hex characters. A PUBLIC handle: how the key is found, and how it appears in the key
 *            list, audit log and logs. Knowing it grants nothing.
 *   secret : 32 random bytes as 43 base64url characters (256 bits). Shown once at creation and
 *            never stored; only its SHA-256 digest is.
 *
 * Why a fast hash (SHA-256) and not bcrypt/argon2? Slow hashes defend LOW-entropy secrets (human
 * passwords) against offline guessing. A 256-bit random secret cannot be guessed whatever the
 * hash speed, and a slow hash would only make every request costlier (and a flood of bad keys a
 * cheap way to burn CPU).
 */
export const KEY_PATTERN = /^wm_([a-f0-9]{8})_([A-Za-z0-9_-]{43})$/;

export interface GeneratedKey {
  prefix: string;
  /** The full key. Show it to the operator ONCE; it cannot be recovered afterwards. */
  secret: string;
  digest: Buffer;
}

export function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function generateKey(): GeneratedKey {
  const prefix = randomBytes(4).toString("hex");
  const secretPart = randomBytes(32).toString("base64url");
  const secret = `wm_${prefix}_${secretPart}`;
  return { prefix, secret, digest: sha256(secretPart) };
}

export interface ParsedKey {
  prefix: string;
  digest: Buffer;
}

/** Splits a presented key. Returns null if it is not even shaped like one (no database lookup then). */
export function parseKey(presented: string): ParsedKey | null {
  const m = KEY_PATTERN.exec(presented);
  if (!m) return null;
  return { prefix: m[1]!, digest: sha256(m[2]!) };
}

/** Constant-time equality of two digests of equal length. */
export function digestsEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
