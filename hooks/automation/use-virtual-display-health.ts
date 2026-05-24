// Screen-off Computer Use — `useVirtualDisplayHealth` hook.
//
// Polls the Rust `virtual_display_health_probe` Tauri command and exposes the
// current `VirtualDisplayHealth` to the renderer. Drives the Settings →
// Automation → Screen-off card status badge ("Ready" / "Setup required" /
// "Unavailable") and the "Set up" button visibility. Mirrors the sandbox
// `useSandboxHealth` hook.

"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { transport } from "@/lib/tauri"
import type { VirtualDisplayHealth } from "@/lib/automation/client"

const DEFAULT_HEALTH: VirtualDisplayHealth = {
  available: false,
  installed: false,
  backend: "unknown",
  driverVersion: "",
  activeMonitor: "",
  lastError: "",
}

interface RawVirtualDisplayHealth {
  available?: boolean
  installed?: boolean
  backend?: string
  driver_version?: string
  driverVersion?: string
  active_monitor?: string
  activeMonitor?: string
  last_error?: string
  lastError?: string
}

function normaliseHealth(raw: RawVirtualDisplayHealth | null | undefined): VirtualDisplayHealth {
  if (!raw) return DEFAULT_HEALTH
  return {
    available: !!raw.available,
    installed: !!raw.installed,
    backend: raw.backend ?? "unknown",
    // Tolerate both serde-camelCase (current) and snake_case so a Tauri/serde
    // config change can't silently break the badge.
    driverVersion: raw.driverVersion ?? raw.driver_version ?? "",
    activeMonitor: raw.activeMonitor ?? raw.active_monitor ?? "",
    lastError: raw.lastError ?? raw.last_error ?? "",
  }
}

export interface UseVirtualDisplayHealthOptions {
  /** Polling interval. Default 5_000ms. */
  pollIntervalMs?: number
  /** Pause polling while this is true. */
  paused?: boolean
}

/**
 * Read the current virtual-display health. Returns `{ health, refresh, error }`.
 * `refresh` triggers an immediate re-probe (e.g. after "Set up" or "Test
 * capture"); the poll runs in the background otherwise.
 */
export function useVirtualDisplayHealth(options: UseVirtualDisplayHealthOptions = {}): {
  health: VirtualDisplayHealth
  refresh: () => Promise<void>
  error: string | null
} {
  const { pollIntervalMs = 5_000, paused = false } = options
  const [health, setHealth] = useState<VirtualDisplayHealth>(DEFAULT_HEALTH)
  const [error, setError] = useState<string | null>(null)
  const aliveRef = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const raw = await transport.call<RawVirtualDisplayHealth>("virtual_display_health_probe")
      if (!aliveRef.current) return
      setHealth(normaliseHealth(raw))
      setError(null)
    } catch (err) {
      if (!aliveRef.current) return
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    aliveRef.current = true
    if (paused) return () => undefined
    const initialHandle = setTimeout(() => {
      void refresh()
    }, 0)
    const pollHandle = setInterval(() => {
      void refresh()
    }, pollIntervalMs)
    return () => {
      aliveRef.current = false
      clearTimeout(initialHandle)
      clearInterval(pollHandle)
    }
  }, [paused, pollIntervalMs, refresh])

  return { health, refresh, error }
}
