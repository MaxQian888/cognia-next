// ADR-0028 Phase 7 — `useSandboxHealth` hook.
//
// Polls the Rust `sandbox_health_probe` Tauri command and exposes the
// current `SandboxHealth` to the renderer. Used by the Settings → Sandbox
// tab status card + the composer's shield indicator (deferred follow-up).

"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { transport } from "@/lib/tauri"
import { refreshCodeSandboxStatus } from "@/lib/ai/code-mode/sandbox-status"

export interface SandboxHealth {
  available: boolean
  backend: string
  version: string
  lastError: string
}

const DEFAULT_HEALTH: SandboxHealth = {
  available: false,
  backend: "unknown",
  version: "",
  lastError: "",
}

interface RawSandboxHealth {
  available: boolean
  backend: string
  version: string
  last_error?: string
  lastError?: string
}

/** Active-probe state surfaced by `verify()`. Distinct from `health` — this
 * reflects whether confinement was actually exercised and enforced, not just
 * whether the backend binary exists. */
export type SandboxProbeStatus = "idle" | "running" | "ok" | "failed"

export interface SandboxProbe {
  status: SandboxProbeStatus
  /** Backend id reported by the probe (empty until first run). */
  backend: string
  /** Human-readable detail: `"ok"` or the reason confinement failed. */
  detail: string
}

const IDLE_PROBE: SandboxProbe = { status: "idle", backend: "", detail: "" }

function normaliseHealth(raw: RawSandboxHealth | null | undefined): SandboxHealth {
  if (!raw) return DEFAULT_HEALTH
  return {
    available: !!raw.available,
    backend: raw.backend ?? "unknown",
    version: raw.version ?? "",
    // Tauri's serde rename emits `last_error` (snake_case); be tolerant
    // of both shapes so future Tauri version bumps don't break this.
    lastError: raw.last_error ?? raw.lastError ?? "",
  }
}

export interface UseSandboxHealthOptions {
  /** Polling interval. Default 5_000ms. */
  pollIntervalMs?: number
  /** Pause polling while this is true. */
  paused?: boolean
}

/**
 * Read the current sandbox health. Returns `{ health, refresh, error }`.
 * `refresh` triggers an immediate re-probe (e.g. after the user clicks
 * "Retry setup"); poll runs in the background otherwise.
 */
export function useSandboxHealth(options: UseSandboxHealthOptions = {}): {
  health: SandboxHealth
  refresh: () => Promise<void>
  error: string | null
  /** Active confinement probe state. `idle` until `verify()` is called. */
  probe: SandboxProbe
  /** Run the active confinement probe on demand. Spawns real confined
   * commands, so it is NOT part of the background poll — call it from a
   * "Verify confinement" action. */
  verify: () => Promise<void>
} {
  const { pollIntervalMs = 5_000, paused = false } = options
  const [health, setHealth] = useState<SandboxHealth>(DEFAULT_HEALTH)
  const [error, setError] = useState<string | null>(null)
  const [probe, setProbe] = useState<SandboxProbe>(IDLE_PROBE)
  const aliveRef = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const raw = await transport.call<RawSandboxHealth>("sandbox_health_probe")
      if (!aliveRef.current) return
      setHealth(normaliseHealth(raw))
      setError(null)
    } catch (err) {
      if (!aliveRef.current) return
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const verify = useCallback(async () => {
    setProbe((p) => ({ ...p, status: "running" }))
    try {
      const raw = await refreshCodeSandboxStatus()
      if (!aliveRef.current) return
      setProbe({
        status: raw.confined ? "ok" : "failed",
        backend: raw.backend,
        detail: raw.detail,
      })
    } catch (err) {
      if (!aliveRef.current) return
      // Web mode (and any IPC failure) → confinement is not verifiable here.
      setProbe({
        status: "failed",
        backend: "",
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  }, [])

  useEffect(() => {
    aliveRef.current = true
    if (paused) return () => undefined
    // Defer the first probe by 0ms so the setState that lands in refresh()
    // doesn't fire synchronously inside the effect body — keeps us off the
    // react-hooks/set-state-in-effect cascade-render path.
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

  return { health, refresh, error, probe, verify }
}
