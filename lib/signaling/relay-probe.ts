/**
 * Ask the rendezvous ("Cognia Cloud", ADR-0170) what it is.
 *
 * `GET /healthz` on the signaling host is public liveness. Since ADR-0170 it
 * carries a `capabilities` block naming the lanes the deployment serves, so
 * a client can tell three things apart that all used to look like "the relay
 * is on": the rendezvous answers and carries the application data lane, the
 * rendezvous answers but predates the data lane (application frames would
 * be forwarded under the signal lane's 8 KiB cap and die on the first large
 * one), and nothing answers at all. The Connectivity settings run this on
 * demand and show the word, the way Plex's "Remote Access" and Tailscale's
 * connection check do, instead of leaving the user to find out on the road.
 *
 * Transport: `createPlatformFetch()`, because a static export has no origin
 * the relay knows, the desktop webview's CSP does not list the rendezvous
 * host, and the Capacitor shell has no CORS at all. The endpoint also sends
 * `access-control-allow-origin: *` for the plain-browser case.
 */

import { probeOriginReachable } from "@/lib/connectivity/origin-reachability"
import {
  createPlatformFetch,
  platformFetchKind,
  type PlatformFetch,
} from "@/lib/network/platform-fetch"

import { SIGNALING_PROTOCOL_VERSION } from "./types"

export type RelayProbeState =
  /** Answered, and the data lane is served: the relay can carry app traffic. */
  | "ready"
  /** Answered without a capabilities block, or without the data lane. */
  | "legacy"
  /** Answered with something that is not a Cognia rendezvous. */
  | "not-a-relay"
  /**
   * Something answered, but this browser origin was not allowed to read it.
   * A plain-browser shell only: the relay predates the readable health
   * endpoint (a pre-CORS deployment), so it is up and it is `legacy`.
   */
  | "cors-blocked"
  /** No answer within the budget, or a network failure. */
  | "unreachable"
  /** The configured signaling URL cannot be turned into a health URL. */
  | "invalid-url"

export interface RelayCapabilities {
  protocol: number
  lanes: string[]
  relayDataLane: boolean
}

export interface RelayProbeResult {
  state: RelayProbeState
  /** The health URL that was probed, for the diagnostics line. */
  healthUrl: string | null
  backend?: string
  version?: string
  capabilities?: RelayCapabilities
  /** Round-trip of the probe when something answered. */
  latencyMs?: number
  /** Why it failed, when it did. Never a stack. */
  error?: string
}

export interface ProbeRelayOptions {
  timeoutMs?: number
  signal?: AbortSignal
  /** Test seam. Defaults to the shell's platform fetch. */
  fetchImpl?: PlatformFetch
  /**
   * Whether a failed read should be retried opaquely to tell "nothing there"
   * from "there, but this origin may not read it". Defaults to true in a
   * plain browser, where the request is at the mercy of the relay's CORS
   * policy, and false in the desktop and Capacitor shells, whose transports
   * do not have one.
   */
  opaqueRetry?: boolean
  /** Test seam for the opaque retry. */
  opaqueFetchImpl?: typeof fetch
  /** Test seam for the clock. */
  now?: () => number
}

const DEFAULT_TIMEOUT_MS = 6_000

/**
 * `wss://host/signaling` becomes `https://host/healthz`. Both backends
 * (the axum server and the Cloudflare Worker) mount `/healthz` at the root,
 * whatever path the WebSocket is on, so the signaling path is dropped rather
 * than rewritten. `ws://` becomes `http://` for a local rendezvous.
 */
export function relayHealthUrl(signalingUrl: string): string | null {
  let url: URL
  try {
    url = new URL(signalingUrl.trim())
  } catch {
    return null
  }
  if (url.protocol === "wss:" || url.protocol === "https:") url.protocol = "https:"
  else if (url.protocol === "ws:" || url.protocol === "http:") url.protocol = "http:"
  else return null
  if (!url.hostname) return null
  url.pathname = "/healthz"
  url.search = ""
  url.hash = ""
  return url.toString()
}

interface HealthzBody {
  ok?: unknown
  backend?: unknown
  version?: unknown
  capabilities?: {
    protocol?: unknown
    lanes?: unknown
    relayDataLane?: unknown
  }
}

/** Pure classification of a health body, so the verdict is testable alone. */
export function classifyHealthz(
  body: unknown
): Pick<RelayProbeResult, "state" | "backend" | "version" | "capabilities"> {
  if (!body || typeof body !== "object") return { state: "not-a-relay" }
  const health = body as HealthzBody
  if (health.ok !== true || typeof health.version !== "string") return { state: "not-a-relay" }
  const backend = typeof health.backend === "string" ? health.backend : undefined
  const raw = health.capabilities
  if (!raw || typeof raw !== "object") {
    return { state: "legacy", backend, version: health.version }
  }
  const lanes = Array.isArray(raw.lanes)
    ? raw.lanes.filter((lane): lane is string => typeof lane === "string")
    : []
  const capabilities: RelayCapabilities = {
    protocol: typeof raw.protocol === "number" ? raw.protocol : 0,
    lanes,
    relayDataLane: raw.relayDataLane === true || lanes.includes("data"),
  }
  return {
    state: capabilities.relayDataLane ? "ready" : "legacy",
    backend,
    version: health.version,
    capabilities,
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") return "timeout"
    return error.message || error.name
  }
  return String(error)
}

/** Whether this client and the probed relay speak the same generation. */
export function relayProtocolMatches(capabilities: RelayCapabilities | undefined): boolean {
  return capabilities?.protocol === SIGNALING_PROTOCOL_VERSION
}

export async function probeRelay(
  signalingUrl: string,
  opts: ProbeRelayOptions = {}
): Promise<RelayProbeResult> {
  const healthUrl = relayHealthUrl(signalingUrl)
  if (!healthUrl) return { state: "invalid-url", healthUrl: null }
  const fetchImpl = opts.fetchImpl ?? createPlatformFetch()
  const now = opts.now ?? (() => Date.now())
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onOuterAbort = () => controller.abort()
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true })
  const started = now()
  try {
    const response = await fetchImpl(healthUrl, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      headers: { accept: "application/json" },
      signal: controller.signal,
    })
    const latencyMs = Math.max(0, now() - started)
    if (!response.ok) {
      return {
        state: "not-a-relay",
        healthUrl,
        latencyMs,
        error: `HTTP ${response.status}`,
      }
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      return { state: "not-a-relay", healthUrl, latencyMs, error: "not JSON" }
    }
    return { ...classifyHealthz(body), healthUrl, latencyMs }
  } catch (error) {
    const described = describeError(error)
    const retry = opts.opaqueRetry ?? platformFetchKind() === "browser"
    if (retry && described !== "timeout" && !controller.signal.aborted) {
      // The same trick the pair screen uses: a cross-origin fetch collapses
      // "no CORS header" and "nothing listening" into one TypeError, and a
      // `no-cors` retry resolving opaquely is the one bit that splits them.
      const origin = new URL(healthUrl)
      const answered = await probeOriginReachable(origin.origin, {
        signal: controller.signal,
        timeoutMs: Math.min(timeoutMs, 3_000),
        path: origin.pathname,
        fetchImpl: opts.opaqueFetchImpl,
      })
      if (answered) return { state: "cors-blocked", healthUrl, error: described }
    }
    return { state: "unreachable", healthUrl, error: described }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener("abort", onOuterAbort)
  }
}
