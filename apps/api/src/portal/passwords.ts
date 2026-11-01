import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Password hashing with scrypt (built into Node, memory-hard).
 *
 * Unlike the machine API keys (256 random bits, so a fast hash is enough), a password is chosen by a
 * person and is guessable, so the hash MUST be slow and memory-hungry: an attacker who steals the
 * table can only test guesses at this cost each. The default parameters are one of the combinations
 * OWASP lists for scrypt (N = 2^15 = 32 MiB, r = 8, p = 3).
 *
 * The stored form is  scrypt$N$r$p$salt$hash  (salt and hash base64url), so the parameters used
 * travel with every hash and can be raised later without invalidating old passwords.
 */
export interface ScryptCost {
  N: number;
  r: number;
  p: number;
}

export const DEFAULT_COST: ScryptCost = { N: 2 ** 15, r: 8, p: 3 };
const KEY_LENGTH = 64;
const MAXMEM = 256 * 1024 * 1024;

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

export async function hashPassword(
  password: string,
  cost: ScryptCost = DEFAULT_COST,
): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH, { ...cost, maxmem: MAXMEM });
  return `scrypt$${cost.N}$${cost.r}$${cost.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  const cost = { N: Number(n), r: Number(r), p: Number(p) };
  if (![cost.N, cost.r, cost.p].every((v) => Number.isInteger(v) && v > 0)) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = await scrypt(password, Buffer.from(salt, "base64url"), expected.length, {
    ...cost,
    maxmem: MAXMEM,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * A real hash of a throwaway password, computed once. A login for an email that does not exist
 * verifies against this, so an unknown email costs the same time as a wrong password and the
 * response time does not reveal which emails have accounts.
 */
let dummy: Promise<string> | undefined;
export function dummyHash(cost: ScryptCost = DEFAULT_COST): Promise<string> {
  dummy ??= hashPassword(randomBytes(12).toString("base64url"), cost);
  return dummy;
}

/** Why a password is not acceptable, or null if it is. */
export function passwordProblem(password: string, email: string): string | null {
  if (password.length < PASSWORD_MIN) return `must be at least ${PASSWORD_MIN} characters`;
  if (password.length > PASSWORD_MAX) return `must be at most ${PASSWORD_MAX} characters`;
  if (password.toLowerCase() === email.toLowerCase()) return "must not be your email address";
  if (/^(.)\1+$/.test(password)) return "must not be one repeated character";
  if (COMMON.has(password.toLowerCase())) return "is too common";
  return null;
}

// A very small deny-list of the passwords that appear first in every leaked list and are long
// enough to pass the length rule. It is a floor, not a defence (see docs/SECURITY.md).
const COMMON = new Set([
  "password12",
  "password123",
  "password1234",
  "1234567890",
  "12345678910",
  "qwertyuiop",
  "qwerty12345",
  "iloveyou123",
  "admin12345",
  "welcome123",
  "letmein1234",
  "workmesh123",
]);
