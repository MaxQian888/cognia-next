"use client"

/**
 * Connection strategy resolver (Wave 1.5/1.6).
 *
 * Given a paired-device row, returns a prioritized list of base URLs the
 * mobile transport should try in order. The contract:
 *
 *   1. LAN URL — either an already-resolved-and-pinned one (`lanBaseUrl`,
 *      produced by `lan-resolver.ts`) or an mDNS advertisement whose TXT
 *      fingerprint matches the stored pin
 *   2. Cloudflared tunnel URL (if active)
 *   3. Last-known baseUrl from the pair payload (cached)
 *
 * Consumed at runtime by `lib/signaling/mobile-controller.ts`, which walks the
 * list with {@link pickReachable} whenever a reachability trigger finds the
 * transport disconnected — that is what lets a phone that paired on the LAN
 * fail over to the tunnel after it leaves the network.
 *
 * **`label` is a diagnostic string, never user-facing copy.** It carries the
 * host being tried, for logs and debug overlays. UI that narrates the sweep
 * localizes off {@link ConnectionCandidate.origin} (which also drives
 * color-coding: LAN green, tunnel blue, cached gray) — putting prose here
 * would hard-code a language into a `lib/` module.
 */

import type { DiscoveredService } from "./mdns-discovery"

export interface ConnectionCandidate {
  /**
   * Locale-free diagnostic label — the host this candidate points at. See the
   * module docs: user-facing text is derived from {@link origin}, not this.
   */
  label: string
  /** Full https://host:port base URL. */
  baseUrl: string
  /**
   * Origin of this candidate so the UI can color-code (LAN green, tunnel
   * blue, cached gray) and pick its own localized wording.
   */
  origin: "mdns" | "tunnel" | "cached"
}

export interface BuildContext {
  /**
   * A LAN base URL already resolved AND fingerprint-verified by
   * `resolveLanBaseUrl`. Ranked first — it is a strictly stronger signal than
   * the {@link discovered} path below, which compares an mDNS TXT record the
   * scanner has not probed for liveness.
   */
  lanBaseUrl?: string | null
  /** Discovered services from the LAN (only used when fingerprint matches). */
  discovered?: DiscoveredService[]
  /** Active cloudflared tunnel public URL (https). */
  tunnelUrl?: string | null
  /** The last baseUrl persisted at pair time. */
  cachedBaseUrl?: string | null
  /** The pinned TLS fingerprint for the paired desktop. */
  expectedFingerprint?: string | null
}

/** Host[:port] of a URL, for {@link ConnectionCandidate.label}. */
function hostLabel(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function buildCandidates(ctx: BuildContext): ConnectionCandidate[] {
  const candidates: ConnectionCandidate[] = []
  const push = (baseUrl: string, origin: ConnectionCandidate["origin"], label?: string): void => {
    const normalised = baseUrl.replace(/\/+$/, "")
    if (!normalised) return
    if (candidates.some((c) => c.baseUrl === normalised)) return
    candidates.push({ label: label ?? hostLabel(normalised), baseUrl: normalised, origin })
  }

  // 1a. Pre-verified LAN address — already probed live and fingerprint-matched.
  if (ctx.lanBaseUrl) push(ctx.lanBaseUrl, "mdns")

  // 1b. mDNS — only trust services whose TXT fingerprint matches the pin.
  for (const svc of ctx.discovered ?? []) {
    if (
      ctx.expectedFingerprint &&
      svc.txt?.fp &&
      svc.txt.fp.toLowerCase() === ctx.expectedFingerprint.toLowerCase()
    ) {
      push(`https://${svc.ip}:${svc.port}`, "mdns", `LAN · ${svc.name}`)
    }
  }

  // 2. Tunnel — if active, treat as fallback.
  if (ctx.tunnelUrl) push(ctx.tunnelUrl, "tunnel")

  // 3. Cached baseUrl from pair time.
  if (ctx.cachedBaseUrl) push(ctx.cachedBaseUrl, "cached")

  return candidates
}

/**
 * Walk candidates in priority order, calling `probe(candidate)` for each.
 * The first probe that resolves with `true` wins — its candidate is
 * returned. If every probe fails, returns `null`.
 */
export async function pickReachable(
  candidates: ConnectionCandidate[],
  probe: (c: ConnectionCandidate) => Promise<boolean>
): Promise<ConnectionCandidate | null> {
  for (const c of candidates) {
    try {
      if (await probe(c)) return c
    } catch {
      // Try next.
    }
  }
  return null
}
