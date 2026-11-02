import { ApiError } from "./client.js";

/**
 * Safety checks shared by both halves of the SDK (the application client and the worker).
 *
 * The API key is a bearer credential: whoever can read it can act as the key. These checks make
 * the two common ways of exposing it (a plain-http URL, and a redirect to somewhere else) fail
 * loudly instead of silently.
 */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const bad = (message: string): ApiError => new ApiError(0, "invalid_input", message);

/**
 * Returns the validated base URL. Rules:
 *  - it must be an absolute http(s) URL;
 *  - it must not contain a user name or password (they would travel in clear text and end up in logs);
 *  - plain `http:` is allowed only for the local machine, because over plain http the API key
 *    crosses the network readable by anyone on the path. Pass `allowInsecureHttp: true` to override
 *    (for example inside a private network you control).
 */
export function checkBaseUrl(apiUrl: string, allowInsecureHttp = false): string {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw bad("apiUrl is not a valid URL (expected something like https://workmesh.example.com)");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw bad("apiUrl must start with https:// (or http:// for the local machine)");
  }
  if (url.username || url.password) {
    throw bad("apiUrl must not contain a user name or password; pass the key as apiKey instead");
  }
  if (url.protocol === "http:" && !allowInsecureHttp && !LOOPBACK.has(url.hostname)) {
    throw bad(
      "apiUrl uses plain http to a remote host, which would send your API key unencrypted. " +
        "Use https://, or pass allowInsecureHttp: true if this network is private and trusted.",
    );
  }
  return apiUrl;
}

/**
 * An API key goes into an HTTP header: it must be printable ASCII with no spaces or line breaks
 * (which could otherwise be used to inject extra headers). The message never repeats the key.
 */
export function checkApiKey(apiKey: string): void {
  if (!/^[\x21-\x7e]{8,512}$/.test(apiKey)) {
    throw bad(
      "apiKey is not valid: it must be the key exactly as shown once in the app, with no spaces or line breaks",
    );
  }
}

/**
 * Text that came from the server is shown to a developer (in logs, in a terminal). Remove control
 * characters (terminal escape sequences, line breaks used to forge log lines) and cap the length.
 */
export function cleanServerText(text: string, max = 500): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, max);
}
