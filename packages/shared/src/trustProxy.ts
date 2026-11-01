import { isIP } from "node:net";

/**
 * `TRUST_PROXY` says which addresses are allowed to tell the API "the real client is X"
 * (via the X-Forwarded-For header). It is a comma-separated list of:
 *   - an IP address:                 172.28.57.10
 *   - a CIDR range:                  172.28.57.0/24
 *   - an Express keyword:            loopback | linklocal | uniquelocal
 *
 * Deliberately NOT accepted: `true`, a hop count (`1`), and ranges that cover everything
 * (`0.0.0.0/0`, `::/0`). Those make the API believe the header from ANYONE, which lets any
 * client pretend to be any address (and so dodge a per-address rate limit or forge an audit
 * record). The safe form is always "exactly the proxy's address".
 */
const KEYWORDS = new Set(["loopback", "linklocal", "uniquelocal"]);

export function isValidTrustProxyEntry(entry: string): boolean {
  if (KEYWORDS.has(entry)) return true;
  const [address, prefix, ...rest] = entry.split("/");
  if (rest.length > 0 || !address) return false;
  const version = isIP(address);
  if (version === 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  const bits = Number(prefix);
  const max = version === 4 ? 32 : 128;
  return bits >= 1 && bits <= max; // 0 would trust every address
}

/** Parses the setting; throws a readable error for anything unsafe or malformed. */
export function parseTrustProxy(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const entries = value
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e !== "");
  const bad = entries.filter((e) => !isValidTrustProxyEntry(e));
  if (bad.length > 0) {
    throw new Error(
      `invalid TRUST_PROXY entr${bad.length > 1 ? "ies" : "y"}: ${bad.join(", ")} ` +
        "(use IP addresses, CIDR ranges narrower than /0, or loopback/linklocal/uniquelocal; " +
        "never 'true' or a hop count)",
    );
  }
  return entries;
}
