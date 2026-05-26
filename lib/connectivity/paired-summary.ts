"use client"

import type { CompanionConfig } from "@/lib/tauri/transport-companion"
import type { PairedSummary } from "./lan-scanner"

/**
 * Project the active {@link CompanionConfig} (the single currently-paired
 * desktop) into the {@link PairedSummary} the LAN scanner consumes for
 * top-of-list ranking + multi-port resolution.
 *
 * Previously inlined in `mobile-server-scan-sheet.tsx`; lifted here so the
 * pair-page discover step and the connection-state scan sheet share one
 * projection instead of two copies that could drift.
 *
 * `lastSeenAt` is intentionally omitted — calling `Date.now()` inside the
 * render-time `useMemo` callers is flagged as an impure call, and the
 * scanner only uses `lastSeenAt` as a dedupe tie-break that the `paired`
 * source tier already outranks. Returns `null` when there's no config or
 * the stored `baseUrl` can't be parsed.
 */
export function companionConfigToPairedSummary(
  config: CompanionConfig | null
): PairedSummary | null {
  if (!config) return null
  try {
    const u = new URL(config.baseUrl)
    if (!u.hostname) return null
    const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80
    return {
      ip: u.hostname,
      port,
      fingerprint: config.serverFingerprint,
      label: config.deviceId ? config.deviceId.slice(0, 8) : undefined,
    }
  } catch {
    return null
  }
}
