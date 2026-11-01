import type { RequestHandler } from "express";
import { logWarn } from "@workmesh/shared";
import { HttpError } from "../http/errors.js";
import { clientIp } from "../http/middleware.js";
import { parseKey } from "./keys.js";
import type { ApiKeyRepository, KeyKind } from "./repository.js";

/** Who is calling the machine plane, as established by a valid API key. */
export interface MachinePrincipal {
  /** null only when machine authentication is switched off (tests). */
  keyId: string | null;
  kind: KeyKind;
  account: string;
  /** Worker keys: the job types this key may handle; null = any type in its account. */
  jobTypes: string[] | null;
  /** `key:<prefix>`: identifies the key in logs without revealing it. */
  actor: string;
}

declare module "express-serve-static-core" {
  interface Request {
    machine?: MachinePrincipal;
  }
}

function unauthenticated(message: string): HttpError {
  return new HttpError(401, "unauthenticated", message, undefined, {
    "WWW-Authenticate": 'Bearer realm="workmesh-api"',
  });
}

/**
 * Authentication for the machine plane (customer clients and workers).
 *
 * `repo = null` means authentication is OFF: every request is treated as an unrestricted caller of
 * the 'default' account. That exists only so the older test suites (written before Phase 8) keep
 * exercising their own subject; the real server always passes a repository (see `server.ts`, and
 * the test that fails if it does not).
 */
export class MachineAuth {
  constructor(private readonly repo: ApiKeyRepository | null) {}

  get enabled(): boolean {
    return this.repo !== null;
  }

  /** Middleware: the caller must present a valid key of the given kind. */
  require(kind: KeyKind): RequestHandler {
    return async (req, _res, next) => {
      try {
        if (!this.repo) {
          req.machine = { keyId: null, kind, account: "default", jobTypes: null, actor: "open" };
          return next();
        }
        const header = req.header("authorization") ?? "";
        const match = /^Bearer\s+(\S+)$/i.exec(header);
        const parsed = match ? parseKey(match[1]!) : null;
        if (!parsed) {
          this.logFailure(req, match ? "malformed_key" : "missing_key");
          return next(unauthenticated("Send your API key as 'Authorization: Bearer <key>'"));
        }
        const result = await this.repo.authenticate(parsed);
        if (!result.ok) {
          this.logFailure(req, result.reason, result.prefix);
          // The caller learns only that the key did not work, never why.
          return next(unauthenticated("Invalid API key"));
        }
        const key = result.key;
        if (key.kind !== kind) {
          logWarn("auth_wrong_kind", {
            requestId: req.requestId,
            ip: clientIp(req),
            keyPrefix: key.prefix,
            have: key.kind,
            need: kind,
            path: req.path,
          });
          return next(
            new HttpError(
              403,
              "forbidden",
              `This endpoint needs a '${kind}' key (this is a '${key.kind}' key)`,
            ),
          );
        }
        req.machine = {
          keyId: key.id,
          kind: key.kind,
          account: key.account,
          jobTypes: key.jobTypes,
          actor: `key:${key.prefix}`,
        };
        next();
      } catch (err) {
        next(err);
      }
    };
  }

  private logFailure(req: Parameters<RequestHandler>[0], reason: string, keyPrefix?: string): void {
    // Enough to diagnose ("revoked key still in use from 10.0.0.5") without recording any secret:
    // the prefix is a public handle, and the presented secret is never logged.
    logWarn("auth_failed", {
      requestId: req.requestId,
      plane: "machine",
      reason,
      ...(keyPrefix ? { keyPrefix } : {}),
      ip: clientIp(req),
      method: req.method,
      path: req.path,
    });
  }
}

/** The caller of a route behind `MachineAuth.require`. */
export function machineOf(req: { machine?: MachinePrincipal }): MachinePrincipal {
  if (!req.machine) throw unauthenticated("Authentication required");
  return req.machine;
}
