"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import type { RecoveryBoot, RecoveryStateV1, RecoverySubsystem } from "@cognia/logging"
import { ensureSidecarReady } from "@/lib/claude/ipc"
import { isTauri } from "@/lib/tauri"
import { applyProxyToRust } from "@/stores/network-proxy"
import { useSettingsStore } from "@/stores/settings/settings-store"
import {
  getRecoveryBoot,
  getRecoveryState,
  recordRecoveryCheckpoint,
  retryRecoverySubsystem,
  sendRecoveryHeartbeat,
  type RecoveryRetryAction,
} from "@/lib/tauri/recovery"
import { createDefaultRecoveryProbes } from "@/lib/recovery/default-probes"
import { runRecoverySequence, type RecoveryProbeSet } from "@/lib/recovery/probes"

/**
 * `checking` blocks the app tree: mounting plugin and background initializers
 * before the decision is in would defeat the gate, because those initializers
 * are exactly what safe mode exists to hold back.
 */
export type RecoveryGateStatus = "checking" | "normal" | "safe"

export interface RecoveryGate {
  status: RecoveryGateStatus
  boot: RecoveryBoot | null
  state: RecoveryStateV1 | null
  /** True while the probe sequence is running. */
  probing: boolean
  retry: (subsystem: RecoverySubsystem, action?: RecoveryRetryAction) => Promise<void>
  refresh: () => Promise<void>
}

/** How often the renderer reports alive. The native healthy timer needs this. */
export const RECOVERY_HEARTBEAT_INTERVAL_MS = 60_000

export interface UseRecoveryGateOptions {
  /** Injected in tests; production builds the real read-only probe set. */
  createProbes?: () => Promise<RecoveryProbeSet>
  heartbeatIntervalMs?: number
}

async function waitForSettingsHydration(): Promise<void> {
  if (useSettingsStore.getState().loaded) return

  await new Promise<void>((resolve) => {
    let settled = false
    let unsubscribe = () => {}
    const finish = () => {
      if (settled) return
      settled = true
      unsubscribe()
      resolve()
    }
    unsubscribe = useSettingsStore.subscribe((next) => {
      if (next.loaded) finish()
    })
    // Close the getState/subscribe race: hydration may have completed between
    // the first snapshot and installing the listener.
    if (useSettingsStore.getState().loaded) finish()
  })
}

async function startSidecarForRecovery(): Promise<void> {
  try {
    // The native network policy is deliberately fail-closed until the
    // account-scoped settings row is hydrated. Recovery runs before ordinary
    // initializers, so explicitly establish that policy before Node inherits
    // the process proxy environment.
    await waitForSettingsHydration()
    await applyProxyToRust()
    await ensureSidecarReady()
  } catch (error) {
    // The following read-only probe records the stable `sidecar.not_ready` or
    // `sidecar.probe_threw` checkpoint. Recovery persistence deliberately does
    // not store the raw IPC error because it may contain a local path.
    console.warn("[recovery] sidecar startup failed", error)
  }
}

/**
 * Owns the renderer's half of diagnostics-first safe mode (ADR-0102 §4).
 *
 * The renderer decides nothing here. It reads the native controller's boot
 * decision, runs the read-only probes in order, reports each outcome back, and
 * renders whatever state comes home. Two details are load-bearing:
 *
 * - **Probes run in both modes.** The native healthy timer only starts once
 *   every enabled checkpoint has passed *and* the renderer has reported alive.
 *   A normal boot that never recorded checkpoints would leave the failure
 *   budgets permanently un-cleared, so a healthy session would never actually
 *   count as recovered.
 * - **Off-desktop is `normal`, synchronously.** `isTauri()` is a sync check, so
 *   web and mobile never flash an empty tree waiting on an IPC call that will
 *   only return `null`.
 */
export function useRecoveryGate(options: UseRecoveryGateOptions = {}): RecoveryGate {
  const desktop = isTauri()
  const [status, setStatus] = useState<RecoveryGateStatus>(desktop ? "checking" : "normal")
  const [boot, setBoot] = useState<RecoveryBoot | null>(null)
  const [state, setState] = useState<RecoveryStateV1 | null>(null)
  const [probing, setProbing] = useState(false)
  const sequenceRunning = useRef(false)
  // Captured once, never reassigned. Callers pass an options object literal,
  // so its identity changes every render; depending on it would make
  // `runSequence` unstable, which re-subscribes the mount effect on each
  // render, restarts the boot query, and leaves the probe sequence stuck after
  // its first checkpoint. The probe factory is a fixed part of the host, so
  // first-render capture is the correct semantics as well as the stable one.
  const createProbesRef = useRef(options.createProbes)

  const refresh = useCallback(async () => {
    const next = await getRecoveryState()
    if (next) setState(next)
  }, [])

  const runSequence = useCallback(async (current: RecoveryStateV1 | null) => {
    // One sequence at a time. A second concurrent run would race the native
    // controller's persisted checkpoint order.
    if (sequenceRunning.current) return
    sequenceRunning.current = true
    setProbing(true)
    try {
      const probes = await (createProbesRef.current ?? createDefaultRecoveryProbes)()
      let latest = current
      await runRecoverySequence(
        probes,
        async (subsystem, result) => {
          const next = await recordRecoveryCheckpoint(subsystem, result.ok, result.reasonCode)
          if (next) {
            latest = next
            setState(next)
          }
        },
        { skip: current?.disabledSubsystems ?? [] }
      )
      if (latest) setState(latest)
    } finally {
      sequenceRunning.current = false
      setProbing(false)
    }
  }, [])

  useEffect(() => {
    if (!desktop) return
    let cancelled = false

    void (async () => {
      const decision = await getRecoveryBoot()
      if (cancelled) return
      if (!decision) {
        // The controller is unreachable. Safe mode is unavailable, which is a
        // reason to boot normally — not a reason to refuse to boot.
        await startSidecarForRecovery()
        if (!cancelled) setStatus("normal")
        return
      }
      setBoot(decision)
      if (decision.requiresSafeShell) setStatus("safe")

      const current = await getRecoveryState()
      if (cancelled) return
      if (current) setState(current)
      if (!decision.requiresSafeShell) {
        if (current?.disabledSubsystems.includes("sidecar") ?? false) {
          // Settings hydration is mounted above this gate. Do not expose
          // plugin/background initializers until its account-scoped database
          // read has completed; dynamic plugin schema adoption may otherwise
          // close the active Dexie connection underneath that read.
          await waitForSettingsHydration()
        } else {
          await startSidecarForRecovery()
        }
        if (cancelled) return
        setStatus("normal")
      }
      if (cancelled) return
      void runSequence(current)
    })()

    return () => {
      cancelled = true
    }
  }, [desktop, runSequence])

  useEffect(() => {
    if (!desktop || status === "checking") return
    let cancelled = false

    const beat = async () => {
      const next = await sendRecoveryHeartbeat()
      if (!cancelled && next) setState(next)
    }
    void beat()

    const interval = setInterval(
      () => void beat(),
      options.heartbeatIntervalMs ?? RECOVERY_HEARTBEAT_INTERVAL_MS
    )
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [desktop, status, options.heartbeatIntervalMs])

  const retry = useCallback(
    async (subsystem: RecoverySubsystem, action: RecoveryRetryAction = "retry") => {
      const next = await retryRecoverySubsystem(subsystem, action)
      if (!next) return
      setState(next)
      if (subsystem === "sidecar" && action === "retry") {
        await startSidecarForRecovery()
      }
      // Re-run from the reopened point so the operator sees the outcome of
      // their decision rather than a stale board.
      void runSequence(next)
    },
    [runSequence]
  )

  return { status, boot, state, probing, retry, refresh }
}
