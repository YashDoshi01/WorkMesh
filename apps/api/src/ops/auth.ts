import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { HttpError } from "../http/errors.js";

export type Role = "viewer" | "operator";

export interface Principal {
  role: Role;
  /** `role:fingerprint`. A short hash of the key that was used, so the audit log can tell keys
   *  apart (and notice a rotation) without ever containing a key. */
  actor: string;
}

declare module "express-serve-static-core" {
  interface Request {
    principal?: Principal;
  }
}

const RANK: Record<Role, number> = { viewer: 1, operator: 2 };

const sha256 = (value: string): Buffer => createHash("sha256").update(value).digest();

interface KnownKey {
  role: Role;
  digest: Buffer;
  actor: string;
}

/**
 * Bearer-token authentication with two roles.
 *
 * Keys come from configuration. They are compared as SHA-256 digests with `timingSafeEqual`
 * and every known key is always checked, so response time does not reveal how much of a key
 * was right or which role it belongs to.
 *
 * Deliberately simple: static keys, no expiry, no per-user identity, no rate limiting of failed
 * attempts. Phase 8 replaces this with managed, hashed, revocable keys. See ADR-0021.
 */
export class Authenticator {
  private readonly keys: KnownKey[];

  constructor(keys: { operatorKey: string; viewerKey: string }) {
    const make = (role: Role, key: string): KnownKey => {
      const digest = sha256(key);
      return { role, digest, actor: `${role}:${digest.toString("hex").slice(0, 8)}` };
    };
    this.keys = [make("operator", keys.operatorKey), make("viewer", keys.viewerKey)];
  }

  /** Identifies the caller or rejects with 401. Never reveals which part was wrong. */
  readonly authenticate: RequestHandler = (req, _res, next) => {
    const header = req.header("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) {
      return next(unauthenticated("Send your API key as 'Authorization: Bearer <key>'"));
    }
    const presented = sha256(match[1]!);
    let found: KnownKey | undefined;
    for (const key of this.keys) {
      if (timingSafeEqual(presented, key.digest)) found = key;
    }
    if (!found) return next(unauthenticated("Invalid API key"));
    req.principal = { role: found.role, actor: found.actor };
    next();
  };
}

function unauthenticated(message: string): HttpError {
  // RFC 9110: a 401 must say which scheme to use.
  return new HttpError(401, "unauthenticated", message, undefined, {
    "WWW-Authenticate": 'Bearer realm="workmesh-operator"',
  });
}

/** Allows the request only for callers whose role is at least `role`; otherwise 403. */
export function requireRole(role: Role): RequestHandler {
  return (req, _res, next) => {
    const principal = req.principal;
    if (!principal) return next(unauthenticated("Authentication required"));
    if (RANK[principal.role] < RANK[role]) {
      return next(
        new HttpError(
          403,
          "forbidden",
          `This action needs the '${role}' role (you have '${principal.role}')`,
        ),
      );
    }
    next();
  };
}

/** The caller, for handlers behind `authenticate`. */
export function principalOf(req: { principal?: Principal }): Principal {
  if (!req.principal) throw unauthenticated("Authentication required");
  return req.principal;
}
