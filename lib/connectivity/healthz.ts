"use client"

import { capacitorHttpGet, combineAbortSignals, getCapacitorHttp } from "./capacitor-http"

/**
 * Public `/api/v1/healthz` probe.
 *
 * Read-only mobile-side companion to the Rust handler in
 * `src-tauri/src/companion_api/healthz.rs`. Used by:
 *
 *   - the LAN scanner to enrich probe hits with the server's TLS SPKI
 *     fingerprint (probe path alone gets 401 from `/whoami` but no
 *     fingerprint; healthz returns it),
 *   - the diagnostics sheet to confirm reachability when the user has
 *     a paired device but reconnect keeps failing,
 *   - the scan UI's fingerprint-mismatch banner — we compare
 *     `healthz.fingerprint` against the paired device record.
 *
 * Resolves to `null` rather than throwing on any failure — callers fall
 * back to their default path (probe with no fingerprint, badge stuck on
 * "offline", etc.). Tests inject `fetchImpl` to bypass CapacitorHttp.
 */

export interface HealthzResult {
  version: string
  fingerprint: string
  advertisedPort: number
  serverId: string
}

export interface FetchHealthzOptions {
  /** Caller cancellation. Required so the diagnostics sheet can drop a
   *  call mid-flight when the user closes the sheet. */
  signal: AbortSignal
  /** Bounded probe time. Defaults to 600ms — same budget as a single
   *  whoami probe so a hostile network can't slow scan to a crawl. */
  timeoutMs?: number
  /** Test seam — bypasses Capacitor and uses the supplied fetch. */
  fetchImpl?: typeof fetch
}

export async function fetchHealthz(
  baseUrl: string,
  opts: FetchHealthzOptions
): Promise<HealthzResult | null> {
  const { signal, timeoutMs = 600, fetchImpl } = opts
  if (signal.aborted) return null
  const url = `${baseUrl.replace(/\/$/, "")}/api/v1/healthz`

  // CapacitorHttp shortcut when running natively and the caller has not
  // injected a test fetch (the same gate the LAN scanner uses).
  const cap = !fetchImpl ? getCapacitorHttp() : null
  if (cap) {
    const resp = await capacitorHttpGet(cap, url, {
      signal,
      timeoutMs,
      serverTrustMode: "self-signed",
    })
    if (!resp || resp.status !== 200) return null
    return parseHealthz(resp.data)
  }

  // Web / test path — standard fetch.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await (fetchImpl ?? fetch)(url, {
      method: "GET",
      signal: combineAbortSignals(signal, controller.signal),
      mode: "cors",
      credentials: "omit",
    })
    if (response.status !== 200) return null
    const body: unknown = await response.json().catch(() => null)
    return parseHealthz(body)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function parseHealthz(raw: unknown): HealthzResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const version = typeof obj.version === "string" ? obj.version : null
  const fingerprint = typeof obj.fingerprint === "string" ? obj.fingerprint : null
  const advertisedPort =
    typeof obj.advertised_port === "number"
      ? obj.advertised_port
      : typeof obj.advertisedPort === "number"
        ? obj.advertisedPort
        : null
  const serverId =
    typeof obj.server_id === "string"
      ? obj.server_id
      : typeof obj.serverId === "string"
        ? obj.serverId
        : null
  if (version === null || fingerprint === null || advertisedPort === null || serverId === null) {
    return null
  }
  return { version, fingerprint, advertisedPort, serverId }
}
