export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    /** Response headers to send with the error (e.g. WWW-Authenticate on a 401). */
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}
