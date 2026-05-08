"use client"

/**
 * Connection strategy resolver (Wave 1.5/1.6).
 *
 * Given a paired-device row, returns a prioritized list of base URLs the
 * mobile transport should try in order. The contract:
 *
 *   1. mDNS-discovered LAN URL (if available + matches the stored fingerprint)
 *   2. Cloudflared tunnel URL (if active)
 *   3. Last-known baseUrl from the pair payload (cached)
 *
 * Each candidate is exposed with a label so the UI can show "尝试通过 LAN
 * 连接" → "尝试通过隧道" → "使用上次成功的地址" while the transport falls
 * through the list.
 */

import type { DiscoveredService } from "./mdns-discovery"

export interface ConnectionCandidate {
  /** Display label, surfaced in the connection-status banner. */
  label: string
  /** Full https://host:port base URL. */
  baseUrl: string
  /**
   * Origin of this candidate so the UI can color-code (LAN green, tunnel
   * blue, cached gray).
   */
  origin: "mdns" | "tunnel" | "cached"
}

export interface BuildContext {
  /** Discovered services from the LAN (only used when fingerprint matches). */
  discovered?: DiscoveredService[]
  /** Active cloudflared tunnel public URL (https). */
  tunnelUrl?: string | null
  /** The last baseUrl persisted at pair time. */
  cachedBaseUrl?: string | null
  /** The pinned TLS fingerprint for the paired desktop. */
  expectedFingerprint?: string | null
}

export function buildCandidates(ctx: BuildContext): ConnectionCandidate[] {
  const candidates: ConnectionCandidate[] = []

  // 1. mDNS — only trust services whose TXT fingerprint matches the pin.
  for (const svc of ctx.discovered ?? []) {
    if (
      ctx.expectedFingerprint &&
      svc.txt?.fp &&
      svc.txt.fp.toLowerCase() === ctx.expectedFingerprint.toLowerCase()
    ) {
      candidates.push({
        label: `LAN · ${svc.name}`,
        baseUrl: `https://${svc.ip}:${svc.port}`,
        origin: "mdns",
      })
    }
  }

  // 2. Tunnel — if active, treat as fallback.
  if (ctx.tunnelUrl) {
    candidates.push({
      label: "隧道",
      baseUrl: ctx.tunnelUrl.replace(/\/$/, ""),
      origin: "tunnel",
    })
  }

  // 3. Cached baseUrl from pair time.
  if (ctx.cachedBaseUrl) {
    const exists = candidates.some((c) => c.baseUrl === ctx.cachedBaseUrl)
    if (!exists) {
      candidates.push({
        label: "上次成功的地址",
        baseUrl: ctx.cachedBaseUrl.replace(/\/$/, ""),
        origin: "cached",
      })
    }
  }

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
