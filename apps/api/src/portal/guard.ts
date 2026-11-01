import type { RequestHandler } from "express";
import { logWarn } from "@workmesh/shared";
import { HttpError } from "../http/errors.js";
import { clientIp } from "../http/middleware.js";
import type { PortalStore, SessionUser } from "./store.js";

declare module "express-serve-static-core" {
  interface Request {
    /** The signed-in customer user, set by `requireSession`. */
    portal?: SessionUser;
    /** The session token as sent in the cookie (needed to sign out). */
    sessionToken?: string;
  }
}

export const SESSION_COOKIE = "wm_session";

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name)
      return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

/**
 * The session cookie. HttpOnly: page scripts cannot read it (so an XSS bug cannot steal the
 * session). SameSite=Lax: the browser will not send it on cross-site POSTs. Secure whenever the
 * site is served over HTTPS (COOKIE_SECURE / production).
 */
export function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

export function clearedCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence for cookie-authenticated requests. A state-changing request must
 *   1. carry the custom header `X-WorkMesh-CSRF: 1`: a cross-site page cannot add a custom header
 *      without a CORS preflight, and this API answers no preflight;
 *   2. if the browser sent an `Origin` header, it must be this very site;
 *   3. not be marked `Sec-Fetch-Site: cross-site` by the browser.
 * On top of SameSite=Lax on the cookie, any one of these stops the classic attack.
 */
export const csrfGuard: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.header("origin");
  let originOk = true;
  if (origin) {
    try {
      originOk = new URL(origin).host === req.get("host");
    } catch {
      originOk = false;
    }
  }
  const fetchSite = req.header("sec-fetch-site");
  if (req.header("x-workmesh-csrf") !== "1" || !originOk || fetchSite === "cross-site") {
    logWarn("csrf_blocked", {
      requestId: req.requestId,
      ip: clientIp(req),
      path: req.path,
      origin: origin ?? "",
    });
    return next(new HttpError(403, "csrf", "This request did not come from the WorkMesh app"));
  }
  next();
};

/** Loads the signed-in user from the session cookie, or answers 401. */
export function requireSession(store: PortalStore): RequestHandler {
  return async (req, res, next) => {
    try {
      const token = readCookie(req.header("cookie"), SESSION_COOKIE);
      const user = token ? await store.findSession(token) : null;
      if (!token || !user) {
        res.setHeader("Cache-Control", "no-store");
        return next(new HttpError(401, "unauthenticated", "Please sign in"));
      }
      req.portal = user;
      req.sessionToken = token;
      res.setHeader("Cache-Control", "no-store");
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Admins only. (Viewers can read everything in their organisation and change nothing.) */
export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (req.portal?.role !== "admin") {
    return next(new HttpError(403, "forbidden", "Only an admin can do this"));
  }
  next();
};

export function userOf(req: { portal?: SessionUser }): SessionUser {
  if (!req.portal) throw new HttpError(401, "unauthenticated", "Please sign in");
  return req.portal;
}
