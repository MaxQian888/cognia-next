"use client"

/**
 * "Is anything listening there?" — the one question a browser can still answer
 * after `fetch` has already refused to tell it anything.
 *
 * # Why this exists
 *
 * A cross-origin `fetch` that the browser blocks — because the peer sent no
 * `Access-Control-Allow-Origin`, because its TLS certificate is self-signed,
 * or because nothing is listening at all — rejects with the same bare
 * `TypeError: Failed to fetch` in every case. The status code, the response
 * headers and the underlying socket error are all withheld from JavaScript by
 * design, so a UI that reports the raw message tells the user nothing they can
 * act on. Every pairing dead end in `components/mobile/pair/` used to end
 * there.
 *
 * A `mode: "no-cors"` retry recovers exactly one bit, and it is the bit that
 * matters: the browser still performs the request and hands back an **opaque**
 * response whatever the status was, so
 *
 *   - resolves → something answered on that origin; the block is a *policy*
 *     decision (CORS / Private Network Access) and the remedy is to allowlist
 *     this origin on the Host.
 *   - rejects  → the connection itself never completed; the remedy is to check
 *     that the Host is running, reachable, and presenting a certificate this
 *     browser trusts.
 *
 * That single bit is the difference between "add `http://127.0.0.1:3000` to
 * Settings → Companion → browser access" and "your desktop isn't running".
 *
 * # Where it came from
 *
 * Extracted verbatim from `loopback-discovery.ts`, which invented the trick for
 * the `/24`-less browser discovery path and kept it private. The pairing flow
 * needs the same discrimination against an *arbitrary* Host base URL from a
 * `cgnp3` invitation, not just the fixed loopback listener, so the probe lives
 * here and both callers share it.
 */

import { combineAbortSignals } from "./capacitor-http"

export interface ProbeOriginOptions {
  /** Caller cancellation, so a closed dialog drops the probe mid-flight. */
  signal: AbortSignal
  /** Bounded probe time. LAN and loopback both answer well inside this. */
  timeoutMs?: number
  /** Probe path. `/healthz` is unauthenticated on every Cognia Host. */
  path?: string
  /** Test seam — defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

/**
 * Detect whether *something* is listening on `baseUrl`, ignoring whether this
 * origin is allowed to read the answer.
 *
 * Never throws: an aborted or unusable probe is reported as "not listening",
 * because every caller's fallback for "we could not tell" is the same as its
 * fallback for "nothing there" — say less, not more.
 */
export async function probeOriginReachable(
  baseUrl: string,
  opts: ProbeOriginOptions
): Promise<boolean> {
  const { signal, timeoutMs = 1500, path = "/healthz", fetchImpl } = opts
  const impl = fetchImpl ?? (typeof fetch === "function" ? fetch : null)
  if (!impl || signal.aborted) return false
  const url = `${baseUrl.replace(/\/$/, "")}${path}`
  try {
    await impl(url, {
      method: "GET",
      mode: "no-cors",
      // No credentials: this probe must never carry cookies to a port that
      // may not be ours.
      credentials: "omit",
      cache: "no-store",
      signal: combineAbortSignals(signal, AbortSignal.timeout(timeoutMs)),
    })
    return true
  } catch {
    return false
  }
}

/**
 * Whether a browser can be expected to complete a TLS handshake with this URL
 * without the user clicking through a certificate interstitial.
 *
 * A Cognia desktop Host terminates HTTPS with a **self-signed** certificate and
 * expects peers to pin its SPKI — something the native mobile client does
 * outside any trust store and a browser cannot do at all
 * (`src-tauri/src/companion_api/browser_access.rs` documents the whole reason
 * the plaintext loopback listener exists). So an `https://` invitation aimed at
 * a LAN address is, from a browser, un-completable by construction, and saying
 * so is far more useful than "Failed to fetch".
 *
 * Loopback is exempt for `http:` ONLY. `http://127.0.0.1` is a potentially
 * trustworthy origin needing no chain at all, so it is fine.
 *
 * `https://` on loopback earns no exemption, and this used to be the bug: the
 * exemption assumed such a Host is "a dev certificate the user already
 * trusted", which is false for the one Host this function exists to describe.
 * `src-tauri/src/companion_api/tls.rs` mints the listener's certificate with
 * rcgen and no CA — self-signed on `127.0.0.1` exactly as on the LAN. Returning
 * `true` there skipped the `tls_untrusted` arm in `pair-failure.ts` and let an
 * opaque `TypeError: Failed to fetch` fall through to `unreachable`, whose
 * advice is "confirm the Host is listening on that address" — while it was
 * listening on exactly that address. The certificate was the whole problem.
 *
 * This is consulted only AFTER an attempt has failed and nothing answered even
 * opaquely (`pair-failure.ts` gates on `peerAnswered === false`), so a false
 * negative costs a mislabel, never a spent invitation.
 */
export function isBrowserTrustableOrigin(baseUrl: string): boolean {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return false
  }
  if (url.protocol === "http:") return isLoopbackHostname(url.hostname)
  if (url.protocol !== "https:") return false
  if (isLoopbackHostname(url.hostname)) return false
  // A public DNS name gets a real certificate from a real CA; a bare LAN IP
  // literal cannot, so an https invitation pointing at one is self-signed.
  return !isIpLiteral(url.hostname) && !url.hostname.endsWith(".local")
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "")
  return host === "localhost" || host === "::1" || /^127\./.test(host)
}

function isIpLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "")
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")
}
