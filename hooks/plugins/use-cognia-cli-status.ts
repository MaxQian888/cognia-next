"use client"

/**
 * Polls the presence + version of the `cognia` plugin-author CLI and the
 * loopback CLI bridge, composing `detectCli` (PATH / managed-dir probe)
 * with `getCliBridgeStatus` (is the desktop's dev bridge listening).
 *
 * Drives the DevTools CLI status card and the toolbar status chip. The
 * poll only runs while a consumer is mounted; it refreshes every 30s and
 * on an explicit `refresh()` (used right after a download finishes).
 *
 * On web / Capacitor both probes return their "not available" sentinels
 * so the UI renders the desktop-only state without crashing.
 */

import { useCallback, useEffect, useRef, useState } from "react"

import { detectCli, type BinaryDetectionResult } from "@/lib/cli-bridge/detect-cli"
import { getCliBridgeStatus, type CliBridgeStatus } from "@/lib/cli-bridge/status"
import { isTauri } from "@/lib/tauri"

const POLL_INTERVAL_MS = 30_000

export interface CogniaCliStatus {
  /** True while the first probe is in flight. */
  loading: boolean
  installed: boolean
  version: string | null
  path: string | null
  /** Raw detection result (carries the error string on failure). */
  detection: BinaryDetectionResult | null
  /** Loopback CLI bridge state — running means `cognia plugin install` works. */
  bridge: CliBridgeStatus | null
  /** Desktop-only: false on web / Capacitor where CLI tooling can't run. */
  supported: boolean
  /** Force an immediate re-probe (e.g. after a download). */
  refresh: () => void
}

export function useCogniaCliStatus(): CogniaCliStatus {
  const supported = isTauri()
  const [loading, setLoading] = useState(supported)
  const [detection, setDetection] = useState<BinaryDetectionResult | null>(null)
  const [bridge, setBridge] = useState<CliBridgeStatus | null>(null)
  const mountedRef = useRef(true)

  const probe = useCallback(async () => {
    if (!supported) return
    const [det, br] = await Promise.all([detectCli("cognia"), getCliBridgeStatus()])
    if (!mountedRef.current) return
    setDetection(det)
    setBridge(br)
    setLoading(false)
  }, [supported])

  useEffect(() => {
    mountedRef.current = true
    void probe()
    if (!supported) return
    const id = setInterval(() => void probe(), POLL_INTERVAL_MS)
    return () => {
      mountedRef.current = false
      clearInterval(id)
    }
  }, [probe, supported])

  const refresh = useCallback(() => {
    void probe()
  }, [probe])

  return {
    loading,
    installed: Boolean(detection?.available),
    version: detection?.version ?? null,
    path: detection?.path ?? null,
    detection,
    bridge,
    supported,
    refresh,
  }
}
