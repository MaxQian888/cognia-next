"use client"

/**
 * Shared LAN-scan lifecycle for the two discovery surfaces that drive
 * `scanLan()`:
 *
 *   • `components/mobile/pair/discover-step.tsx` — the pair-page Discover
 *     step (auto-scans on mount, manual rescan, no explicit permission
 *     gate — it relies on `scanLan` surfacing a permission error).
 *   • `components/mobile/connection-state-sheets/mobile-server-scan-sheet.tsx`
 *     — the bottom sheet (scans while `open`, requests iOS Local Network
 *     permission up-front, resets its list each open).
 *
 * Both used to hand-roll the AbortController dance, the streamed-`onFound`
 * dedupe, the `scanning` flag, and the permission handling. This hook owns
 * that shared machinery; callers keep their own *sorting* (latency vs
 * recency tie-break) and presentation since those legitimately differ.
 *
 * `scanLan` already dedupes + upgrades entries server-side via its internal
 * `emit`, so the consumer-side merge is a simple upsert-by-id (last write
 * wins) — no rank comparison needed here.
 */

import { useCallback, useEffect, useRef, useState } from "react"

import { scanLan, type DiscoveredServer, type PairedSummary } from "@/lib/connectivity/lan-scanner"
import {
  requestMdnsPermission,
  type MdnsPermissionOutcome,
} from "@/lib/connectivity/mdns-permission"

export type MdnsPermissionKind = MdnsPermissionOutcome["kind"]

export interface UseLanScanOptions {
  /** Gate the scan. Default `true` (Discover step). The sheet passes `open`. */
  enabled?: boolean
  /** Currently-paired desktop(s) — ranked at the top + drive multi-port probe. */
  paired?: PairedSummary[]
  /** Previously-seen servers, shown before the scan surfaces live hits. */
  history?: DiscoveredServer[]
  /** mDNS listen window (ms). */
  mdnsWindowMs?: number
  /** Clear the list at the start of every run (sheet: true; Discover: false). */
  resetOnRun?: boolean
  /** Request iOS Local Network permission before scanning (sheet only). */
  requestPermission?: typeof requestMdnsPermission
  /** Test seam — replaces the real `scanLan`. */
  scan?: typeof scanLan
}

export interface UseLanScanResult {
  servers: DiscoveredServer[]
  scanning: boolean
  /** Outcome of `requestPermission`, or `null` when none was requested. */
  permission: MdnsPermissionKind | null
  /** True when permission was denied OR the scan threw a permission error. */
  permissionDenied: boolean
  /** Explicit re-run (resets transient state, then scans again). */
  rescan: () => void
}

const EMPTY_HISTORY: readonly DiscoveredServer[] = []

function seedFromHistory(history: readonly DiscoveredServer[]): DiscoveredServer[] {
  return history.map((h) => ({ ...h, source: "history" as const }))
}

function isPermissionError(err: unknown): boolean {
  if (!err) return false
  const msg = err instanceof Error ? err.message : String(err)
  return /permission|denied|not allowed/i.test(msg)
}

export function useLanScan(options: UseLanScanOptions = {}): UseLanScanResult {
  const { enabled = true } = options

  // Snapshot history at mount so a fresh `[]` default per render doesn't
  // reset the seed. Callers that pass a stable memoised array keep it.
  const [stableHistory] = useState<readonly DiscoveredServer[]>(options.history ?? EMPTY_HISTORY)
  const [servers, setServers] = useState<DiscoveredServer[]>(() => seedFromHistory(stableHistory))
  const [scanning, setScanning] = useState<boolean>(() => enabled)
  const [permission, setPermission] = useState<MdnsPermissionKind | null>(null)
  const [permissionDenied, setPermissionDenied] = useState(false)
  const [runToken, setRunToken] = useState(0)

  const abortRef = useRef<AbortController | null>(null)

  // Keep the latest non-primitive options in a ref so the scan effect can
  // read them without listing identity-unstable arrays/functions as deps.
  // Written from an effect (never during render) so it stays compiler-safe.
  const latest = useRef(options)
  useEffect(() => {
    latest.current = options
  })

  const rescan = useCallback(() => {
    setRunToken((t) => t + 1)
  }, [])

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    abortRef.current = controller
    let cancelled = false

    void (async () => {
      const { paired, mdnsWindowMs, resetOnRun, requestPermission, scan = scanLan } = latest.current

      setScanning(true)
      setPermissionDenied(false)
      if (resetOnRun) setServers(seedFromHistory(stableHistory))

      if (requestPermission) {
        const outcome = await requestPermission()
        if (cancelled) return
        setPermission(outcome.kind)
        if (outcome.kind === "denied") {
          setPermissionDenied(true)
          setScanning(false)
          return
        }
      }

      try {
        await scan({
          signal: controller.signal,
          mdnsWindowMs,
          history: stableHistory as DiscoveredServer[],
          paired,
          onFound: (svc) => {
            if (cancelled) return
            setServers((prev) => {
              const next = prev.filter((s) => s.id !== svc.id)
              next.push(svc)
              return next
            })
          },
        })
      } catch (err) {
        if (!cancelled && isPermissionError(err)) setPermissionDenied(true)
      } finally {
        if (!cancelled && !controller.signal.aborted) setScanning(false)
      }
    })()

    return () => {
      cancelled = true
      controller.abort()
    }
    // `enabled` + `runToken` are the only run triggers; option values are
    // read fresh from `latest.current` inside the effect (a ref, so it's
    // not a reactive dependency).
  }, [enabled, runToken, stableHistory])

  return { servers, scanning, permission, permissionDenied, rescan }
}
