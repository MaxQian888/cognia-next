"use client"

/**
 * Desktop-side mDNS browse — the discovery half of the advertisement this app
 * has published since Wave 1.5.
 *
 * The desktop broadcast `_cognia._tcp` from the beginning but never listened
 * for it, so pairing *this* desktop to another Cognia host (ADR-0082) meant
 * typing an address for a machine that was announcing its own the whole time.
 * `lib/connectivity/mdns-discovery.ts` covers the mobile direction (Capacitor
 * zeroconf); this covers the desktop one (Rust `mdns-sd`).
 *
 * Desktop-only by construction: browsing needs a multicast socket, which
 * neither a browser nor the Capacitor webview can open. Off-desktop this
 * resolves to an empty list rather than throwing, so a caller can render the
 * same "nothing found" state everywhere.
 */

import { isTauri } from "@/lib/platform/detect"
import { transport } from "@/lib/tauri"
import { loggers } from "@cognia/logging"

const log = loggers.sync

/** Mirrors `companion_api::commands::BrowsedHost` (flattened `DiscoveredHost`). */
export interface BrowsedHost {
  /** `cognia-ab12cd._cognia._tcp.local.` — the mDNS identity. */
  fullname: string
  /** Instance label without the service suffix. */
  instanceName: string
  hostname: string
  /** Every resolved address, IPv4 first. */
  addresses: string[]
  port: number
  /** TXT `ver`. */
  appVersion?: string
  /** TXT `fp` — TLS SPKI fingerprint, pinnable before the first request. */
  tlsFingerprint?: string
  /** `https://addr:port`, IPv6 already bracketed. `null` if it resolved bare. */
  baseUrl: string | null
  /** This machine's own advertisement. */
  isSelf: boolean
}

export interface BrowseLanHostsOptions {
  /** Sweep window. Rust clamps to 500–10000 ms. */
  timeoutMs?: number
}

/**
 * One bounded sweep for `_cognia._tcp` hosts on the LAN.
 *
 * Never throws: discovery is an assist, and a caller that renders a list has
 * nothing useful to do with a multicast failure beyond showing an empty list.
 */
export async function browseLanHosts(opts: BrowseLanHostsOptions = {}): Promise<BrowsedHost[]> {
  if (!isTauri()) return []
  try {
    const hosts = await transport.call<BrowsedHost[]>("companion_mdns_browse", {
      timeoutMs: opts.timeoutMs,
    })
    return Array.isArray(hosts) ? hosts : []
  } catch (err) {
    log.warn("mdns browse failed", { err })
    return []
  }
}

/**
 * Find the advertisement belonging to a pairing payload's host.
 *
 * Matched on the TLS SPKI fingerprint, never on the address: the address is
 * exactly the field that goes stale (DHCP move, invitation generated on
 * another interface), and it is the one the fingerprint lets us correct.
 * Comparison is case-insensitive because the TXT record is lower-case hex
 * while payloads have carried both cases.
 */
export function findHostByFingerprint(
  hosts: readonly BrowsedHost[],
  fingerprint: string | undefined | null
): BrowsedHost | null {
  if (!fingerprint) return null
  const wanted = fingerprint.trim().toLowerCase()
  if (!wanted) return null
  return hosts.find((host) => (host.tlsFingerprint ?? "").trim().toLowerCase() === wanted) ?? null
}

/** How a pasted invitation lines up with what is actually on the network. */
export type PayloadReachability =
  /** Nothing is advertising this fingerprint — it may still be reachable over a tunnel. */
  | { kind: "not-advertising" }
  /** Advertising, and the invitation already points at the live address. */
  | { kind: "match"; host: BrowsedHost }
  /**
   * Advertising, but from a different address than the invitation carries.
   * Pairing with the stale address fails with a connection error that names
   * nothing useful; `liveBaseUrl` is the address that works.
   */
  | { kind: "address-differs"; host: BrowsedHost; liveBaseUrl: string }

/**
 * Compare an invitation's address against the live advertisement for the same
 * host.
 *
 * Trailing slashes and case differ freely between an invitation and an mDNS
 * resolution without meaning anything, so both sides are normalised before the
 * comparison — otherwise every paste would report a spurious mismatch.
 */
export function classifyPayloadReachability(
  hosts: readonly BrowsedHost[],
  payload: { baseUrl?: string; fingerprint?: string } | null
): PayloadReachability {
  const host = findHostByFingerprint(hosts, payload?.fingerprint)
  if (!host) return { kind: "not-advertising" }
  if (!host.baseUrl) return { kind: "match", host }

  const normalise = (url: string) => url.trim().replace(/\/+$/, "").toLowerCase()
  const claimed = normalise(payload?.baseUrl ?? "")
  if (!claimed || claimed === normalise(host.baseUrl)) return { kind: "match", host }
  return { kind: "address-differs", host, liveBaseUrl: host.baseUrl }
}
