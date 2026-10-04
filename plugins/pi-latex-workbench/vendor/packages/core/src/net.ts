/**
 * Shared pinned-HTTPS transport for outbound provider/source fetches:
 *
 * - DNS is resolved up front and EVERY address must be public when private
 *   addresses are denied (the policy default); the request is then pinned to
 *   that verified answer set via a custom `lookup` — no TOCTOU between the
 *   check and the connect.
 * - HTTPS only, redirects are never followed (a 3xx is surfaced as a status
 *   for the caller to record), bounded timeout, bounded body.
 *
 * `Fetcher` is the transport seam: production uses `makePinnedFetcher`;
 * tests inject a stub so everything above the wire (parsing, hashing,
 * evidence, retries) is exercised for real without pretending a network
 * call happened.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { ERROR_CODES, WorkbenchError } from "@latexwb/contracts";

export interface FetchResult {
  status: number;
  body: Uint8Array;
}

export type Fetcher = (url: URL, signal: AbortSignal) => Promise<FetchResult>;

/** IPv4/IPv6 ranges that must never be reached when private addresses are
 * denied — loopback, RFC1918, link-local, CGNAT, documentation, multicast,
 * reserved, IPv6 ULA/link-local, IPv4-mapped IPv6, 6to4/Teredo doc ranges. */
export function isPrivateAddress(addr: string): boolean {
  if (addr.includes(".")) {
    const p = addr.split(".").map((s) => Number.parseInt(s, 10));
    if (p.length !== 4 || p.some((x) => Number.isNaN(x) || x < 0 || x > 255)) return true;
    const [a, b] = p as [number, number, number, number];
    return (
      a === 0 || a === 10 || a === 127 || // this-net, private, loopback
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local
      (a === 172 && b >= 16 && b <= 31) || // RFC1918
      (a === 192 && b === 168) || // RFC1918
      (a === 192 && b === 0) || // IETF protocol assignments
      (a === 198 && (b === 18 || b === 19)) || // benchmark
      (a === 198 && b === 51) || (a === 203 && b === 0) || // documentation
      a >= 224 // multicast + reserved
    );
  }
  const lower = addr.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true;
  if (lower.startsWith("ff")) return true; // multicast
  if (lower.startsWith("2001:db8")) return true; // documentation
  if (lower.startsWith("::ffff:")) {
    const mapped = lower.slice("::ffff:".length);
    return isPrivateAddress(mapped.includes(".") ? mapped : `0.0.0.0`);
  }
  return false;
}

/** The only range a fake-IP proxy may be declared in: 198.18.0.0/15 (RFC 2544 benchmark). */
const FAKE_IP_SUPERNET = { base: (198 << 24) | (18 << 16), prefix: 15 };

function ipv4ToInt(addr: string): number | null {
  const p = addr.split(".").map((s) => Number.parseInt(s, 10));
  if (p.length !== 4 || p.some((x) => Number.isNaN(x) || x < 0 || x > 255)) return null;
  return (((p[0] as number) << 24) | ((p[1] as number) << 16) | ((p[2] as number) << 8) | (p[3] as number)) >>> 0;
}

function inCidr(ip: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return ((ip & mask) >>> 0) === ((base & mask) >>> 0);
}

/**
 * Hosts behind a TUN-mode proxy with fake-IP DNS (Clash/Surge/sing-box)
 * resolve every public name into 198.18.0.0/15; the proxy then connects to
 * the real host by name. The host policy may declare such ranges
 * (`network.fakeIpCidrs`, ADR-0007). Only sub-ranges of 198.18.0.0/15 are
 * honoured — RFC 1918, loopback, link-local etc. can never be opted in.
 */
export function isDeclaredFakeIp(addr: string, cidrs: readonly string[]): boolean {
  const ip = addr.toLowerCase().startsWith("::ffff:") ? ipv4ToInt(addr.slice(7)) : ipv4ToInt(addr);
  if (ip === null) return false;
  for (const cidr of cidrs) {
    const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(cidr);
    if (m === null) continue;
    const base = ipv4ToInt(m[1] as string);
    const prefix = Number.parseInt(m[2] as string, 10);
    if (base === null || prefix < FAKE_IP_SUPERNET.prefix || prefix > 32) continue;
    if (!inCidr(base, FAKE_IP_SUPERNET.base, FAKE_IP_SUPERNET.prefix)) continue;
    if (inCidr(ip, base, prefix)) return true;
  }
  return false;
}

export interface PinnedFetchOptions {
  /** Service label used in error messages ("crossref", "venue-source"). */
  service: string;
  userAgent: string;
  accept: string;
  maxBytes: number;
  timeoutMs: number;
  /** Host-policy `network.fakeIpCidrs` (sub-ranges of 198.18.0.0/15 only). */
  fakeIpCidrs?: readonly string[] | undefined;
}

/**
 * Real transport: resolve → verify all addresses public → request pinned
 * to the verified list. Never follows redirects; a 3xx is surfaced as a
 * status for the caller to record, not chased.
 */
export function makePinnedFetcher(options: PinnedFetchOptions): Fetcher {
  return (url, signal) =>
    new Promise<FetchResult>((resolvePromise, rejectPromise) => {
      void (async () => {
        if (url.protocol !== "https:") {
          rejectPromise(
            new WorkbenchError(
              ERROR_CODES.POLICY_DENIED,
              `${options.service}: only https:// URLs may be fetched (${url.protocol} denied)`,
            ),
          );
          return;
        }
        const host = url.hostname;
        const addrs = await dnsLookup(host, { all: true, verbatim: true });
        if (addrs.length === 0) {
          rejectPromise(new WorkbenchError(ERROR_CODES.RUNTIME_UNAVAILABLE, `DNS for ${host} returned no addresses`));
          return;
        }
        const fakeIp = options.fakeIpCidrs ?? [];
        const privateHit = addrs.find((a) => isPrivateAddress(a.address) && !isDeclaredFakeIp(a.address, fakeIp));
        if (privateHit !== undefined) {
          const hint = isDeclaredFakeIp(privateHit.address, ["198.18.0.0/15"])
            ? " (this looks like a fake-IP proxy DNS answer; a host operator can declare it in runtime/host-policy.json network.fakeIpCidrs)"
            : "";
          rejectPromise(
            new WorkbenchError(
              ERROR_CODES.POLICY_DENIED,
              `DNS for ${host} resolved to private/reserved address ${privateHit.address} — request denied${hint}`,
            ),
          );
          return;
        }
        const req = httpsRequest(
          url,
          {
            method: "GET",
            timeout: options.timeoutMs,
            headers: {
              "User-Agent": options.userAgent,
              Accept: options.accept,
            },
            // Pin the connection to the verified answer set — the DNS check
            // above cannot be bypassed by a second resolution.
            lookup: (_h, opts, cb) => {
              if (opts.all) cb(null, addrs);
              else cb(null, addrs[0]!.address, addrs[0]!.family);
            },
            signal,
          },
          (res) => {
            const chunks: Buffer[] = [];
            let total = 0;
            res.on("data", (chunk: Buffer) => {
              total += chunk.length;
              if (total > options.maxBytes) {
                req.destroy(new WorkbenchError(ERROR_CODES.RUNTIME_UNAVAILABLE, `${options.service} response exceeds ${options.maxBytes} byte cap`));
                return;
              }
              chunks.push(chunk);
            });
            res.on("end", () => {
              resolvePromise({ status: res.statusCode ?? 0, body: new Uint8Array(Buffer.concat(chunks)) });
            });
            res.on("error", rejectPromise);
          },
        );
        req.on("timeout", () => req.destroy(new WorkbenchError(ERROR_CODES.RUNTIME_UNAVAILABLE, `${options.service} request timed out`)));
        req.on("error", rejectPromise);
        req.end();
      })().catch(rejectPromise);
    });
}
