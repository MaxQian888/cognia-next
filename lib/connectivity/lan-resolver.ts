"use client"

/**
 * Runtime LAN re-resolution for the companion transport. ADR-0021.
 *
 * The mobile `baseUrl` is otherwise only chosen at pair time / manual
 * switch, so after a network change it can keep pointing at a tunnel
 * address even when the desktop is reachable on the local network. This
 * helper probes — bounded and abortable — whether the *currently paired*
 * desktop is live on the LAN and, if so, returns its LAN baseUrl so the
 * caller can repoint the transport. That makes `classifyWsHost(baseUrl)`
 * truthful, which is what the LAN-first gate in `CompanionTransport`
 * relies on.
 *
 * Reuses `scanLan` (mDNS + `/24` probe + `/healthz` fingerprint
 * enrichment) rather than reimplementing discovery. Trust is gated on the
 * pinned TLS fingerprint: a hit is only accepted when its fingerprint
 * matches `config.serverFingerprint`, so a neighbouring cognia desktop
 * can never hijack the connection.
 */

import { classifyWsHost } from "./lan-classify"
import { scanLan, type DiscoveredServer } from "./lan-scanner"
import type { CompanionConfig } from "@/lib/tauri/companion-storage"

/** Default companion port — mirrors `lan-scanner`'s `DEFAULT_PORT`. */
const DEFAULT_PORT = 27890

export interface ResolveLanOptions {
  /** The currently paired device's config — only `baseUrl` + the pinned
   *  `serverFingerprint` are read. */
  config: Pick<CompanionConfig, "baseUrl" | "serverFingerprint">
  /** Abort the scan on unmount / network flap / a newer trigger. */
  signal: AbortSignal
  /** Test seam — defaults to the real `scanLan`. */
  scanLanImpl?: typeof scanLan
  /** mDNS listen window (ms). Kept short so each trigger is cheap. */
  mdnsWindowMs?: number
  /** Per-probe fetch timeout (ms). */
  perProbeTimeoutMs?: number
}

export interface ResolveLanResult {
  /** A live, fingerprint-matched LAN baseUrl, or `null` when none found. */
  lanBaseUrl: string | null
}

/**
 * Resolve the paired desktop to a live LAN baseUrl. Never throws — on any
 * failure (no pin, malformed config, scan error, abort, no hit) it returns
 * `{ lanBaseUrl: null }` so the caller leaves the existing baseUrl in place.
 */
export async function resolveLanBaseUrl(opts: ResolveLanOptions): Promise<ResolveLanResult> {
  const fingerprint = opts.config.serverFingerprint
  // Without a fingerprint pin we cannot safely trust any LAN hit — a probe
  // signature alone doesn't authenticate the desktop.
  if (!fingerprint) return { lanBaseUrl: null }

  let host: string
  let port: number
  try {
    const url = new URL(opts.config.baseUrl)
    host = url.hostname.replace(/^\[|\]$/g, "")
    port = url.port ? Number(url.port) : DEFAULT_PORT
  } catch {
    return { lanBaseUrl: null }
  }

  const scan = opts.scanLanImpl ?? scanLan
  let servers: DiscoveredServer[]
  try {
    servers = await scan({
      signal: opts.signal,
      onFound: () => {
        // Streaming callback unused — we evaluate the final deduped list.
      },
      // Seed the known desktop so the scanner sweeps the alt-port set for
      // its IP. The echoed `paired` entry is filtered out below; only a
      // genuine `mdns`/`probe` discovery is accepted.
      paired: [{ ip: host, port, fingerprint }],
      mdnsWindowMs: opts.mdnsWindowMs ?? 1500,
      perProbeTimeoutMs: opts.perProbeTimeoutMs ?? 600,
    })
  } catch {
    return { lanBaseUrl: null }
  }

  const pin = fingerprint.toLowerCase()
  for (const server of servers) {
    // `paired` / `history` entries are echoes of stored config, not a
    // liveness check — only mDNS advertisements and live probes count.
    if (server.source !== "mdns" && server.source !== "probe") continue
    // A probe hit only carries a fingerprint after `/healthz` enrichment;
    // without one we cannot authenticate it.
    if (!server.fingerprint) continue
    if (server.fingerprint.toLowerCase() !== pin) continue
    if (classifyWsHost(server.baseUrl) !== "ws-lan") continue
    return { lanBaseUrl: server.baseUrl }
  }
  return { lanBaseUrl: null }
}
