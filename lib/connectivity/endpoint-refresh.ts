"use client"

/**
 * Channel-inventory refresh for the companion transport. ADR-0021.
 *
 * The QR pair payload carries exactly ONE `baseUrl` — the desktop picks
 * tunnel-over-LAN when both exist (`companion_api/commands.rs`
 * `companion_issue_pair_jwt`). That leaves every paired client with a
 * single-channel view of a multi-channel host, and both halves of the split
 * are broken:
 *
 *   • Paired on the LAN → the phone never learns the tunnel URL. Leaving the
 *     network strands it on the WebRTC tier alone; with WebRTC disabled, the
 *     signaling service unreachable, or a symmetric NAT and no TURN relay,
 *     there is no route home at all short of re-pairing.
 *   • Paired over the tunnel → the payload's `fingerprint` is empty (Cloudflare
 *     terminates TLS upstream, so the desktop's self-signed SPKI is not what
 *     the client sees), and {@link resolveLanBaseUrl} refuses to trust an
 *     unpinned LAN hit. Such a device can NEVER be promoted back to the LAN —
 *     it keeps routing through Cloudflare while sitting next to the desktop.
 *
 * This module closes both gaps with one authenticated read. After a successful
 * connection the client asks the desktop for its full reachability set and
 * caches it in {@link CompanionConfig}, so a later network change has
 * somewhere to fail over to and a tunnel-paired device finally has a pin.
 */

import { transport } from "@/lib/tauri"
import {
  loadCompanionConfig,
  saveCompanionConfig,
  type CompanionConfig,
} from "@/lib/tauri/transport-companion"

/** Wire shape of the `companion_endpoints` RPC response. */
export interface CompanionEndpoints {
  /** `https://<lan-ip>:<port>`, or null when loopback-bound / no interface. */
  lanBaseUrl: string | null
  /** Active cloudflared public URL (quick or named), or null when none runs. */
  tunnelBaseUrl: string | null
  /** Lower-case hex SHA-256 of the desktop's self-signed TLS SPKI. */
  fingerprint: string
  /** Stable installation id — same value `/api/v1/healthz` returns. */
  serverId: string
}

export interface RefreshEndpointsOptions {
  /** Test seam — defaults to the live `transport.call`. */
  callImpl?: <T>(name: string, args?: Record<string, unknown>) => Promise<T>
  /** Test seam — defaults to the module-level config cache. */
  loadConfigImpl?: () => CompanionConfig | null
  /** Test seam — defaults to the real persisting writer. */
  saveConfigImpl?: (config: CompanionConfig) => Promise<void>
}

function normalise(url: string | null | undefined): string | undefined {
  if (typeof url !== "string") return undefined
  const trimmed = url.trim().replace(/\/+$/, "")
  return trimmed.length > 0 ? trimmed : undefined
}

function parseEndpoints(raw: unknown): CompanionEndpoints | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  // `fingerprint` / `serverId` are required by the spec but an older desktop
  // predating this arm can't reach here at all (it 404s), so a missing key
  // means a malformed body rather than a version skew — reject it.
  if (typeof obj.fingerprint !== "string" || typeof obj.serverId !== "string") return null
  const lan = obj.lanBaseUrl
  const tunnel = obj.tunnelBaseUrl
  return {
    lanBaseUrl: typeof lan === "string" ? lan : null,
    tunnelBaseUrl: typeof tunnel === "string" ? tunnel : null,
    fingerprint: obj.fingerprint,
    serverId: obj.serverId,
  }
}

/**
 * Project a freshly-read endpoint set onto a config, returning the next config
 * or `null` when nothing changed (so the caller can skip a SecureStorage
 * round-trip on the common no-op path).
 *
 * Exported for direct unit testing — the merge rules carry the security
 * decisions and deserve assertions without an RPC in the way.
 */
export function mergeEndpointsIntoConfig(
  config: CompanionConfig,
  endpoints: CompanionEndpoints
): CompanionConfig | null {
  const next: CompanionConfig = { ...config }
  let changed = false

  // Mirror the server truthfully: a channel the desktop no longer exposes is
  // CLEARED, not kept. A stale quick-tunnel hostname is dead the moment
  // cloudflared restarts (the subdomain is regenerated per run), so retaining
  // it would only add a guaranteed-failing probe to every failover sweep.
  for (const key of ["lanBaseUrl", "tunnelBaseUrl"] as const) {
    const value = normalise(endpoints[key])
    if (next[key] !== value) {
      if (value === undefined) delete next[key]
      else next[key] = value
      changed = true
    }
  }

  // Backfill the TLS pin ONLY when the device has none — this is the
  // tunnel-paired case, where the QR could not carry one. An existing pin is
  // never overwritten: the whole point of pinning is that the pinned value
  // does not move, and this response arrives over a channel (the tunnel) whose
  // TLS is terminated by a third party.
  if (!config.serverFingerprint && endpoints.fingerprint) {
    next.serverFingerprint = endpoints.fingerprint
    changed = true
  }

  return changed ? next : null
}

/**
 * Read the desktop's channel inventory and cache it on the paired config.
 *
 * Never throws and never rejects: a failure here must not disturb a working
 * connection, and the caller (a network/resume trigger) has no recovery to
 * perform. Returns the config actually in effect afterwards, or `null` when
 * there is no pairing to refresh.
 */
export async function refreshCompanionEndpoints(
  options: RefreshEndpointsOptions = {}
): Promise<CompanionConfig | null> {
  const call = options.callImpl ?? ((name, args) => transport.call(name, args))
  const loadConfig = options.loadConfigImpl ?? loadCompanionConfig
  const saveConfig = options.saveConfigImpl ?? saveCompanionConfig

  const config = loadConfig()
  if (!config) return null

  let raw: unknown
  try {
    raw = await call<unknown>("companion_endpoints", {})
  } catch {
    // Offline, 404 on a desktop older than this arm, or a transport error —
    // keep whatever inventory we already had.
    return config
  }

  const endpoints = parseEndpoints(raw)
  if (!endpoints) return config

  // Re-read rather than reusing the pre-await snapshot: the LAN re-resolver
  // repoints `baseUrl` on the same triggers that drive this refresh, and
  // writing back a stale snapshot would silently undo it.
  const current = loadConfig() ?? config
  const merged = mergeEndpointsIntoConfig(current, endpoints)
  if (!merged) return current

  try {
    await saveConfig(merged)
  } catch {
    // Keychain / quota failure — the in-memory cache already advanced inside
    // `saveCompanionConfig`, so the inventory still applies for this session.
  }
  return merged
}
