"use client"

/**
 * Browser-companion discovery over the loopback browser-access listener.
 *
 * # Why the other two paths cannot serve a browser
 *
 * A browser tab has no discovery at all today, and neither existing path can
 * give it one:
 *
 * - **mDNS** needs a multicast socket. No browser API exposes one.
 * - **The `/24` probe** is seeded by `getPrivateLocalIps()`, which reads
 *   WebRTC ICE candidates. Modern browsers anonymise host candidates to
 *   `<uuid>.local`, and `local-ip.ts` correctly discards those — so the seed
 *   list is empty and the sweep never dispatches a single request.
 *
 * What a browser *can* reach is the plaintext loopback listener described in
 * `src-tauri/src/companion_api/browser_access.rs`: `http://127.0.0.1` is
 * "potentially trustworthy" per the Secure Contexts spec, so it needs no
 * certificate chain and is exempt from mixed-content blocking. That listener
 * is the browser client's intended door, and it is on a fixed port.
 *
 * This module therefore answers a narrower question than the LAN scanner —
 * "is there a Host on *this machine* that this tab may talk to?" — which is
 * the realistic browser-companion case (the web client and the desktop app on
 * one computer).
 *
 * # Why the blocked state matters as much as the found state
 *
 * The listener is off by default, and when on it answers only browser origins
 * the user has allowlisted. A tab whose origin is not on that list gets a
 * `403 web_origin_forbidden` **without** CORS headers, so `fetch` rejects with
 * a bare `TypeError` that is indistinguishable from "nothing is listening".
 * Reporting that as "no hosts found" is the failure shape this repo keeps
 * finding: a UI that states an absence it never verified.
 *
 * A `mode: "no-cors"` retry separates them. An opaque response means something
 * answered on that port; a rejection means nothing did. That turns a dead end
 * into an actionable message naming the exact origin to allowlist.
 */

import { combineAbortSignals } from "./capacitor-http"
import { fetchHealthz, type HealthzResult } from "./healthz"

/**
 * Mirrors Rust `browser_access::DEFAULT_BROWSER_PORT` — one above the HTTPS
 * companion port, and like it outside the 789x range a local Clash/mixed
 * proxy claims.
 */
export const DEFAULT_BROWSER_ACCESS_PORT = 27891

/**
 * Loopback authorities to try, in order. Both spellings are probed because
 * the host's origin allowlist is matched by exact string, and a user who
 * allowlisted `http://localhost:3000` has a tab whose requests to
 * `127.0.0.1` and to `localhost` are, to the browser, different origins'
 * business — but to us, two chances to find the same Host.
 */
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost"] as const

export type LoopbackProbeOutcome =
  /** A Host answered and this origin may talk to it. */
  | { kind: "found"; baseUrl: string; health: HealthzResult }
  /**
   * A Host answered but refused this browser origin. `origin` is the exact
   * string to add under Settings → Companion → browser access **on that
   * machine** — not a guess: it is this tab's own origin.
   */
  | { kind: "blocked"; baseUrl: string; origin: string }
  /** Nothing answered on any loopback candidate. */
  | { kind: "absent" }

export interface DiscoverLoopbackHostOptions {
  signal: AbortSignal
  /** Browser-access listener port. Defaults to 27891. */
  port?: number
  /** Per-candidate budget. Loopback is instant when it is there at all. */
  timeoutMs?: number
  /** Test seam — defaults to the real `fetchHealthz`. */
  healthzFetcher?: typeof fetchHealthz
  /** Test seam — raw fetch used for the opaque no-cors retry. */
  fetchImpl?: typeof fetch
  /** Test seam — this tab's origin. Defaults to `window.location.origin`. */
  origin?: string
}

function currentOrigin(explicit?: string): string {
  if (explicit) return explicit
  if (typeof window === "undefined") return ""
  return window.location.origin
}

/**
 * Detect whether *something* is listening, ignoring whether we are allowed to
 * read its answer.
 *
 * `no-cors` makes the browser issue the request and hand back an opaque
 * response whatever the status was — the one signal available to JS that
 * distinguishes "refused this origin" from "connection refused".
 */
async function somethingIsListening(
  baseUrl: string,
  signal: AbortSignal,
  timeoutMs: number,
  fetchImpl: typeof fetch
): Promise<boolean> {
  const composite = combineAbortSignals(signal, AbortSignal.timeout(timeoutMs))
  try {
    await fetchImpl(`${baseUrl}/healthz`, {
      method: "GET",
      mode: "no-cors",
      // No credentials: this probe must never carry cookies to a port that
      // may not be ours.
      credentials: "omit",
      cache: "no-store",
      signal: composite,
    })
    return true
  } catch {
    return false
  }
}

/**
 * Look for a Cognia Host on this machine's loopback browser-access listener.
 *
 * Best-effort and non-throwing: a caller renders a list, and has nothing to do
 * with an exception beyond showing the same empty state.
 */
export async function discoverLoopbackHost(
  opts: DiscoverLoopbackHostOptions
): Promise<LoopbackProbeOutcome> {
  const {
    signal,
    port = DEFAULT_BROWSER_ACCESS_PORT,
    timeoutMs = 800,
    healthzFetcher = fetchHealthz,
    fetchImpl = typeof fetch === "function" ? fetch : undefined,
    origin,
  } = opts

  for (const hostname of LOOPBACK_HOSTS) {
    if (signal.aborted) return { kind: "absent" }
    const baseUrl = `http://${hostname}:${port}`

    // The allowed path first: a readable answer settles it outright and
    // carries the version/fingerprint the UI wants to show.
    const health = await healthzFetcher(baseUrl, { signal, timeoutMs })
    if (health) return { kind: "found", baseUrl, health }

    if (signal.aborted) return { kind: "absent" }

    // Unreadable. Distinguish "refused this origin" from "nobody home".
    if (fetchImpl && (await somethingIsListening(baseUrl, signal, timeoutMs, fetchImpl))) {
      return { kind: "blocked", baseUrl, origin: currentOrigin(origin) }
    }
  }

  return { kind: "absent" }
}
