import { randomUUID } from "node:crypto";
import type { ErrorRequestHandler, RequestHandler } from "express";
import { logError, logInfo } from "@workmesh/shared";
import { HttpError } from "./errors.js";

declare module "express-serve-static-core" {
  interface Request {
    requestId: string;
  }
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** Reuses a well-formed inbound X-Request-Id (so a gateway can set it), else generates one. */
export const requestContext: RequestHandler = (req, res, next) => {
  const inbound = req.header("x-request-id");
  req.requestId = inbound && SAFE_REQUEST_ID.test(inbound) ? inbound : randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    logInfo("request", {
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Number(process.hrtime.bigint() - start) / 1e6,
    });
  });
  next();
};

export const notFound: RequestHandler = (req, _res, next) => {
  next(new HttpError(404, "not_found", `No route for ${req.method} ${req.path}`));
};

function bodyParserError(err: unknown): HttpError | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const type = (err as { type?: string }).type;
  if (type === "entity.parse.failed") {
    return new HttpError(400, "invalid_json", "Request body is not valid JSON");
  }
  if (type === "entity.too.large") {
    return new HttpError(413, "payload_too_large", "Request body is too large");
  }
  return undefined;
}

// Express identifies error handlers by their four-argument arity, so _next must stay.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const http = err instanceof HttpError ? err : bodyParserError(err);
  if (http) {
    for (const [name, value] of Object.entries(http.headers ?? {})) res.setHeader(name, value);
    res.status(http.status).json({
      error: {
        code: http.code,
        message: http.message,
        ...(http.details === undefined ? {} : { details: http.details }),
        requestId: req.requestId,
      },
    });
    return;
  }
  // Unknown failure: log the detail, return nothing sensitive.
  logError("unhandled_error", {
    requestId: req.requestId,
    error: err instanceof Error ? err.message : String(err),
  });
  res.status(500).json({
    error: { code: "internal_error", message: "Internal server error", requestId: req.requestId },
  });
};
