"use client"

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"

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
  unlockSecretStore as unlockSecretStoreNative,
  type RecoveryRetryAction,
} from "@/lib/tauri/recovery"
import {
  getSecretStoreReadiness,
  onSecretStoreRecovered,
  reportSecretStoreFailure,
  setSecretStoreReadiness,
  subscribeSecretStoreReadiness,
  type SecretStoreReadiness,
} from "@/lib/credentials/secret-store-readiness"
import { createDefaultRecoveryProbes } from "@/lib/recovery/default-probes"
import {
  runRecoverySequence,
  type RecoveryProbeResult,
  type RecoveryProbeSet,
} from "@/lib/recovery/probes"

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
  /** The encrypted secret store's state, settled natively at cold boot. */
  secretStore: SecretStoreReadiness
  /** True while an explicit keychain unlock is in flight. */
  unlockingSecretStore: boolean
  /** True when the last explicit unlock attempt failed (cancelled or denied). */
  secretStoreUnlockFailed: boolean
  /** Explicit, possibly interactive, retry of the secret store (user click). */
  unlockSecretStore: () => Promise<void>
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

async function startSidecarForRecovery(): Promise<RecoveryProbeResult> {
  try {
    // The native network policy is deliberately fail-closed until the
    // account-scoped settings row is hydrated. Recovery runs before ordinary
    // initializers, so explicitly establish that policy before Node inherits
    // the process proxy environment.
    await waitForSettingsHydration()
    await applyProxyToRust()
  } catch (error) {
    // Only recognize the stable credential code. Never persist or log raw
    // IPC errors, which may contain proxy URLs or credentials.
    const credentialUnavailable =
      error === "PROXY_CREDENTIAL_UNAVAILABLE" ||
      (error instanceof Error && error.message === "PROXY_CREDENTIAL_UNAVAILABLE") ||
      (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "PROXY_CREDENTIAL_UNAVAILABLE")
    return {
      ok: false,
      reasonCode: credentialUnavailable ? "proxy.credential_unavailable" : "proxy.apply_failed",
    }
  }
  try {
    return (await ensureSidecarReady()).ready
      ? { ok: true }
      : { ok: false, reasonCode: "sidecar.not_ready" }
  } catch {
    return { ok: false, reasonCode: "sidecar.start_failed" }
  }
}

/**
 * Native policy that depends on stored credentials, re-applied after the
 * secret store unlocks. Both are idempotent: the proxy push is deduped by its
 * serialized payload (a failed push is not recorded) and provider keys only
 * load when an earlier load did not complete.
 */
async function reapplyProxyAfterUnlock(): Promise<void> {
  await applyProxyToRust()
}

async function reloadSpeechKeysAfterUnlock(): Promise<void> {
  await useSettingsStore.getState().ensureProviderKeys()
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
  const secretStore = useSyncExternalStore(
    subscribeSecretStoreReadiness,
    getSecretStoreReadiness,
    getSecretStoreReadiness
  )
  const [unlockingSecretStore, setUnlockingSecretStore] = useState(false)
  const [secretStoreUnlockFailed, setSecretStoreUnlockFailed] = useState(false)
  const unlockRunning = useRef(false)
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

  const runSequence = useCallback(
    async (
      current: RecoveryStateV1 | null,
      retryRequest?: { subsystem: RecoverySubsystem; action: RecoveryRetryAction }
    ) => {
      // Include the retry IPC and startup wait in the same lock. Otherwise two
      // clicks can reset checkpoints while the first startup is still pending.
      if (sequenceRunning.current) return
      sequenceRunning.current = true
      setProbing(true)
      try {
        if (retryRequest) {
          current = await retryRecoverySubsystem(retryRequest.subsystem, retryRequest.action)
          if (!current) return
          setState(current)
        }
        // Settings are mounted above the gate. Finish their database reads
        // before exposing initializers that can change the active Dexie schema.
        await waitForSettingsHydration()
        const probes = await (createProbesRef.current ?? createDefaultRecoveryProbes)()
        const preparedProbes: RecoveryProbeSet = {
          ...probes,
          sidecar: async () => {
            // Start only when earlier checkpoints passed, including when a
            // renderer failure brought a cold process into safe mode. The
            // underlying health probe remains read-only.
            const startup = await startSidecarForRecovery()
            if (!startup.ok) return startup
            return probes.sidecar()
          },
        }
        let latest = current
        const steps = await runRecoverySequence(
          preparedProbes,
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
        // Do not mount the application after only one successful checkpoint.
        // Recovering is usable once the full sequence succeeds; the native
        // controller keeps its crash budgets until the healthy dwell completes.
        setStatus(
          steps.every((step) => step.result.ok) && latest?.mode !== "safe" ? "normal" : "safe"
        )
      } catch {
        console.warn("[recovery] checkpoint sequence failed")
        setStatus("safe")
      } finally {
        sequenceRunning.current = false
        setProbing(false)
      }
    },
    []
  )

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
      // Publish the settled store state before any initializer mounts, so a
      // locked keychain is surfaced once here rather than rediscovered (and
      // logged) by every credential consumer.
      if (decision.secretStore !== "uninitialized") setSecretStoreReadiness(decision.secretStore)
      if (decision.requiresSafeShell) setStatus("safe")

      const current = await getRecoveryState()
      if (cancelled) return
      if (current) setState(current)
      // Preserve a known failure until the operator retries it. Re-running
      // read-only probes against a deliberately stopped sidecar would replace
      // the original cause with a misleading not-ready failure.
      if (
        decision.requiresSafeShell &&
        current?.suspectSubsystem &&
        !current.disabledSubsystems.includes(current.suspectSubsystem)
      )
        return
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
      await runSequence(null, { subsystem, action })
    },
    [runSequence]
  )

  // Consumers of stored credentials that live above/beside the app tree and
  // are not re-mounted by an unlock: re-apply them when the store recovers.
  useEffect(() => {
    if (!desktop) return
    const offProxy = onSecretStoreRecovered(reapplyProxyAfterUnlock)
    const offSpeech = onSecretStoreRecovered(reloadSpeechKeysAfterUnlock)
    return () => {
      offProxy()
      offSpeech()
    }
  }, [desktop])

  const unlockSecretStore = useCallback(async () => {
    if (unlockRunning.current) return
    unlockRunning.current = true
    setUnlockingSecretStore(true)
    setSecretStoreUnlockFailed(false)
    try {
      await unlockSecretStoreNative()
      // Only a successful native retry flips the state; this re-runs every
      // deferred consumer (subscription init, proxy, speech keys, plugins).
      setSecretStoreReadiness("ready")
    } catch (error) {
      if (!reportSecretStoreFailure(error, "recovery.unlock")) {
        // Timeout / worker failure: the native error is not persisted or shown.
        console.warn("[recovery] secure storage unlock failed")
      }
      setSecretStoreUnlockFailed(true)
    } finally {
      unlockRunning.current = false
      setUnlockingSecretStore(false)
    }
  }, [])

  return {
    status,
    boot,
    state,
    probing,
    retry,
    refresh,
    secretStore,
    unlockingSecretStore,
    secretStoreUnlockFailed,
    unlockSecretStore,
  }
}
