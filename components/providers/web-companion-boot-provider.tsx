"use client"

import { useEffect, useState } from "react"

import { usePlatform } from "@/hooks/use-platform"
import { getActiveBrowserVault } from "@/lib/runtime/browser-vault"
import { hasStoredWebPairing, hasWebCompanionTarget } from "@/lib/platform/web-companion"
import { parseHostFeatureManifest } from "@/lib/platform/host-feature-manifest"
import { classifyWsHost } from "@/lib/connectivity/lan-classify"
import {
  runtimeHostSnapshotFromManifest,
  setRuntimeSnapshot,
  updateRuntimeSnapshot,
} from "@/lib/runtime/runtime-snapshot-store"
import { registerRuntimeTargetSubscriptionStopper } from "@/lib/runtime/runtime-target-lifecycle"
import {
  installEventDrivenSync,
  installForegroundSync,
  installNetworkSync,
  installWorkflowRunStatusSync,
  runStagedSyncDown,
  runSyncDown,
} from "@/lib/sync/companion-sync"
import {
  describeCompanionCredentialDiagnosis,
  diagnoseCompanionCredential,
} from "@/lib/companion/credential-availability"
// The sentinel this provider PUBLISHES, and `companion-outbound-runner-provider`
// refuses to install as a routing context. Producer and consumer share the
// constant so a rename cannot silently un-guard the consumer.
import { PLACEHOLDER_WEB_COMPANION_TARGET_ID } from "@/lib/runtime/runtime-target"
import { hydrateCompanionConfig } from "@/lib/tauri/transport-companion"
import type { CompanionPlaneHealth } from "@/lib/tauri/transport-companion"
import { remoteEventResyncCoordinator } from "@/lib/tauri/resync-coordinator"
import { transport } from "@/lib/tauri"
import { loggers } from "@cognia/logging"
import {
  installHostStateSyncForTarget,
  type InstalledHostStateSync,
} from "@/lib/sync/host-state-service"
import {
  notifyWebHostBindingsFailed,
  notifyWebHostBindingsReady,
  registerWebHostBindingOwner,
} from "@/lib/companion/web-host-binding-lifecycle"

const log = loggers.shell

const RECOVERY_BACKOFF_MS = [250, 1_000, 4_000, 16_000, 30_000] as const

/**
 * Read the Host's own verdict off a rejected call.
 *
 * Shape-checked rather than `instanceof CompanionError`: the error crosses a
 * module boundary, and a class identity that does not survive that boundary
 * would make this guard throw inside the very `catch` meant to handle the
 * failure — turning a retryable blip into a dead boot.
 */
function hostRefusal(
  error: unknown
): { code: string; message: string; retryable: boolean; retryAfterMs?: number } | null {
  if (typeof error !== "object" || error === null) return null
  const candidate = error as { code?: unknown; retryable?: unknown; retryAfterMs?: unknown }
  if (typeof candidate.code !== "string" || typeof candidate.retryable !== "boolean") return null
  return {
    code: candidate.code,
    message: error instanceof Error ? error.message : String(error),
    retryable: candidate.retryable,
    ...(typeof candidate.retryAfterMs === "number" &&
    Number.isFinite(candidate.retryAfterMs) &&
    candidate.retryAfterMs >= 0
      ? { retryAfterMs: candidate.retryAfterMs }
      : {}),
  }
}

/**
 * Cloud-companion boot for the PLAIN BROWSER (ADR-0059 C1).
 *
 * The web build becomes a thin client of a cognia-server when
 * `hasWebCompanionTarget()` is true (build-time server URL or an existing
 * pairing). This is the browser sibling of `CompanionBootProvider` minus
 * everything Capacitor: no native plugins, no push, no deeplinks, no status
 * bar — just config hydration, an honest runtime snapshot, and the sync
 * installers (which are webview-agnostic).
 *
 * It never navigates. An unusable or absent pairing is published as a
 * `requires-pairing` snapshot and `SurfaceAvailabilityBoundary` offers `/pair`
 * on the surfaces that need a Host.
 *
 * No-op on Tauri (the desktop IS the server) and on Capacitor (the mobile
 * provider owns boot there). Also a no-op on web-standalone — a browser with
 * no server target keeps the BYOK stub behavior.
 */
export function WebCompanionBootProvider({ children }: { children: React.ReactNode }) {
  const platform = usePlatform()
  const [configRevision, setConfigRevision] = useState(0)

  useEffect(() => {
    const unregisterOwner = registerWebHostBindingOwner()
    const onConfigChanged = () => setConfigRevision((revision) => revision + 1)
    window.addEventListener("cognia:companion-config-changed", onConfigChanged)
    return () => {
      window.removeEventListener("cognia:companion-config-changed", onConfigChanged)
      unregisterOwner()
    }
  }, [])

  useEffect(() => {
    if (platform !== "web") return

    const companionConfigured = hasWebCompanionTarget()
    // A build-time `NEXT_PUBLIC_COGNIA_SERVER_URL` makes this browser a thin
    // client, but it is NOT a credential: without a stored pairing there is
    // nothing to connect with. Tracked separately so the opening snapshot can
    // say "offline, needs pairing" instead of spinning on "connecting" — the
    // state that used to read as paired everywhere the snapshot is consumed.
    const storedPairing = hasStoredWebPairing()
    const vaultUnlocked = Boolean(getActiveBrowserVault())
    if (!companionConfigured) {
      setRuntimeSnapshot({
        target: { id: "web-standalone", kind: "standalone", platform: "web" },
        vaultState: vaultUnlocked ? "unlocked" : "locked",
        connectionState: "online",
      })
      return
    }

    // `unavailable` is the credential axis, not the Vault axis: it is what
    // `resolveSurfaceAvailability` reads as `requires-pairing`, and therefore
    // the only state that offers `/pair` as the recovery. An unlocked Vault
    // with no pairing used to report `unlocked` + `offline`, which resolved to
    // a bare "you are offline" screen with no way to pair from it.
    const unpairedVaultState = vaultUnlocked ? "unavailable" : "locked"
    setRuntimeSnapshot({
      target: {
        id: "web-companion",
        kind: "companion",
        platform: "web",
        hostKind: "cloud",
      },
      vaultState: storedPairing ? (vaultUnlocked ? "unlocked" : "locked") : unpairedVaultState,
      connectionState: storedPairing ? "connecting" : "offline",
    })

    let cancelled = false
    const cleanup: Array<() => void> = []
    let disposed = false
    const disposeSubscriptions = () => {
      if (disposed) return
      disposed = true
      cancelled = true
      for (const dispose of cleanup) {
        try {
          dispose()
        } catch {
          // teardown is best-effort
        }
      }
    }
    const unregisterSubscriptionStopper =
      registerRuntimeTargetSubscriptionStopper(disposeSubscriptions)

    void (async () => {
      const config = await hydrateCompanionConfig()
      if (cancelled) return

      if (!config) {
        // `load()` collapses four unrelated causes into one null. Re-derive
        // which one it was before naming it, or the pairing panel reports
        // "credential is unavailable" for a locked Vault, an unpaired client
        // and a half-written record alike — and every remedy it then offers is
        // a guess. Read-only, so it is safe on this failure path.
        const diagnosis = await diagnoseCompanionCredential()
        // The diagnosis is a second await, and `disposeSubscriptions` (which
        // `restartWebHostBindings` calls) can land inside it. Publishing after
        // that clobbers the snapshot the newer boot just wrote, pinning the UI
        // on "requires pairing" for a pairing that succeeded.
        if (cancelled) return
        notifyWebHostBindingsFailed(
          new Error(
            `The selected Web Host credential is unavailable: ${describeCompanionCredentialDiagnosis(diagnosis)}.`
          )
        )
        updateRuntimeSnapshot({
          vaultState: getActiveBrowserVault() ? "unavailable" : "locked",
          connectionState: "offline",
          host: undefined,
        })
        // Deliberately no navigation. `SurfaceAvailabilityBoundary` resolves
        // this snapshot to `requires-pairing` and offers `/pair` on the
        // surfaces that actually need a Host, which leaves the rest of the app
        // (settings, account, the pair flow itself) reachable. Redirecting from
        // here fought that boundary and hijacked whatever route the user asked
        // for — including the ones that would have let them fix the pairing.
        log.info("web companion: no usable Host credential — surfaces will prompt to pair")
        return
      }

      updateRuntimeSnapshot({
        target: {
          id: config.targetId ?? PLACEHOLDER_WEB_COMPANION_TARGET_ID,
          kind: "companion",
          platform: "web",
          hostKind: classifyWsHost(config.baseUrl) === "ws-lan" ? "desktop" : "cloud",
        },
      })

      const statefulTransport = asConnectionStateTransport(transport)
      if (statefulTransport) {
        const applyConnectionState = (state: CompanionConnectionState) => {
          updateRuntimeSnapshot({
            connectionState:
              state === "offline" || state === "unauthenticated" ? "offline" : "connecting",
          })
        }
        applyConnectionState(statefulTransport.getConnectionState())
        cleanup.push(statefulTransport.onConnectionStateChange(applyConnectionState))
      }

      const planeTransport = asPlaneHealthTransport(transport)
      if (!planeTransport) {
        updateRuntimeSnapshot({
          connectionState: "offline",
          host: { compatible: false, operations: [], grants: [] },
        })
        notifyWebHostBindingsFailed(new Error("The selected Web Host transport is unavailable."))
        return
      }

      let eventReady = false
      let needsManifestRefresh = false
      let completedRecovery = false
      let recoveryAttempt = 0
      let recoveryTimer: ReturnType<typeof setTimeout> | null = null
      let recoveryInFlight: Promise<void> | null = null
      let backgroundSyncInstalled = false
      let bindingsReady = false
      let hostStateSync: InstalledHostStateSync | null = null

      cleanup.push(() => {
        if (recoveryTimer !== null) clearTimeout(recoveryTimer)
        recoveryTimer = null
      })

      const loadManifest = async (): Promise<boolean> => {
        const manifestValue = await transport.call("host_feature_manifest", {})
        if (cancelled) return false
        const manifest = parseHostFeatureManifest(manifestValue)
        if (
          manifest?.schemaVersion !== 2 ||
          manifest.transportCapabilities?.eventStreamReady !== 1
        ) {
          updateRuntimeSnapshot({
            connectionState: "offline",
            host: { compatible: false, operations: [], grants: [] },
          })
          notifyWebHostBindingsFailed(
            new Error("The selected Web Host manifest is incompatible with event replay.")
          )
          return false
        }
        updateRuntimeSnapshot({
          host: runtimeHostSnapshotFromManifest(manifest, { hostStateWriteEnabled: false }),
        })
        if (manifest.features["session.state-sync"]?.version === 1 && !hostStateSync) {
          // Host-state is addressed in the HOST's namespace, not ours.
          // `config.targetId` is the id we filed this pairing under; the Host
          // writes its channels under its own active runtime target and
          // refuses anything else. Fall back to our id only for a Host too old
          // to declare one.
          const scope = manifest.hostStateScope
          hostStateSync = await installHostStateSyncForTarget({
            transport,
            accountId: scope?.accountId ?? config.accountId ?? "local-default",
            runtimeTargetId:
              scope?.runtimeTargetId ?? config.targetId ?? PLACEHOLDER_WEB_COMPANION_TARGET_ID,
          })
          updateRuntimeSnapshot({ host: runtimeHostSnapshotFromManifest(manifest) })
          cleanup.push(() => hostStateSync?.stop())
          cleanup.push(
            remoteEventResyncCoordinator.register(
              "host-state",
              () => hostStateSync?.resync() ?? Promise.resolve()
            )
          )
        }
        return true
      }

      const waitForManifest = async (): Promise<boolean> => {
        while (!cancelled) {
          try {
            const compatible = await loadManifest()
            if (compatible || cancelled) return compatible
            return false
          } catch (error) {
            if (cancelled) return false
            // The Host answers every refusal with `retryable`, and this loop
            // used to discard it: a deterministic refusal (a contract
            // violation, a revoked grant) was retried on the same schedule as
            // a dropped packet, forever. The retries then spent the device's
            // remote-execution quota, so the Host started answering 429 to
            // everything — a second failure, caused entirely by the response
            // to the first, and one that hides it.
            const refusal = hostRefusal(error)
            if (refusal && !refusal.retryable) {
              updateRuntimeSnapshot({
                connectionState: "offline",
                host: { compatible: false, operations: [], grants: [] },
              })
              log.warn("web companion: host refused the manifest", {
                code: refusal.code,
                error: refusal.message,
              })
              notifyWebHostBindingsFailed(
                new Error(`The Host refused this client: ${refusal.message} (${refusal.code}).`)
              )
              return false
            }
            updateRuntimeSnapshot({ connectionState: "connecting" })
            log.warn("web companion: host manifest unavailable", {
              error: error instanceof Error ? error.message : String(error),
            })
            // When the Host names a wait, take it: our own schedule is what
            // keeps a rate limit pinned. A wait of zero is not a wait, though —
            // honouring it verbatim would drop the backoff entirely and spin
            // this loop with no pause at all, which is the quota-burning
            // behaviour the `retryable` check above exists to end. Zero (and
            // anything absent or nonsensical) falls back to our own schedule.
            const hostAsked = refusal?.retryAfterMs
            const backoff =
              RECOVERY_BACKOFF_MS[Math.min(recoveryAttempt, RECOVERY_BACKOFF_MS.length - 1)]
            const delay =
              hostAsked !== undefined && hostAsked > 0
                ? hostAsked
                : Math.round(backoff * (0.85 + Math.random() * 0.3))
            recoveryAttempt++
            await new Promise<void>((resolve) => {
              recoveryTimer = setTimeout(() => {
                recoveryTimer = null
                resolve()
              }, delay)
            })
          }
        }
        return false
      }

      if (!(await waitForManifest()) || cancelled) return
      recoveryAttempt = 0

      cleanup.push(
        remoteEventResyncCoordinator.register("*", async () => {
          await runSyncDown()
          await hostStateSync?.resync()
        })
      )
      // Subscribe before the authoritative sync so invalidations cannot fall
      // into a sync-complete/subscription-not-yet-open race window.
      cleanup.push(installEventDrivenSync())
      cleanup.push(installWorkflowRunStatusSync())

      const installBackgroundSync = async () => {
        if (backgroundSyncInstalled || cancelled) return
        backgroundSyncInstalled = true
        cleanup.push(installForegroundSync())
        const teardownNetworkSync = await installNetworkSync()
        if (cancelled) {
          teardownNetworkSync()
          return
        }
        cleanup.push(teardownNetworkSync)
      }

      const scheduleRecovery = () => {
        if (cancelled || recoveryTimer !== null || recoveryInFlight !== null || !eventReady) return
        const base = RECOVERY_BACKOFF_MS[Math.min(recoveryAttempt, RECOVERY_BACKOFF_MS.length - 1)]
        recoveryAttempt++
        recoveryTimer = setTimeout(
          () => {
            recoveryTimer = null
            recover()
          },
          Math.round(base * (0.85 + Math.random() * 0.3))
        )
      }

      function recover() {
        if (cancelled || !eventReady || recoveryInFlight) return
        if (recoveryTimer !== null) {
          clearTimeout(recoveryTimer)
          recoveryTimer = null
        }
        recoveryInFlight = (async () => {
          updateRuntimeSnapshot({ connectionState: "connecting" })
          if (needsManifestRefresh) {
            if (!(await loadManifest()) || cancelled) return
            needsManifestRefresh = false
          }
          // Only the `critical` stage gates "online": preferences, characters,
          // the chat list and its per-conversation state. Awaiting the whole
          // pull here is what kept a correctly paired client on "connecting"
          // for as long as its largest table took, with every already-arrived
          // row unrendered behind that state. `interactive` and `background`
          // keep draining on the returned run, each behind an idle wait, so
          // they interleave with the shell instead of preceding it.
          const staged = runStagedSyncDown()
          await staged.critical
          if (cancelled || !eventReady) return
          updateRuntimeSnapshot({ connectionState: "online" })
          completedRecovery = true
          recoveryAttempt = 0
          await installBackgroundSync()
          if (!bindingsReady) {
            bindingsReady = true
            notifyWebHostBindingsReady()
          }
        })()
          .catch((error) => {
            if (cancelled) return
            needsManifestRefresh = true
            updateRuntimeSnapshot({ connectionState: "connecting" })
            log.warn("web companion: connection recovery failed", {
              error: error instanceof Error ? error.message : String(error),
            })
            scheduleRecovery()
          })
          .finally(() => {
            recoveryInFlight = null
            if (!cancelled && eventReady && needsManifestRefresh) scheduleRecovery()
          })
      }

      const applyPlaneHealth = (health: CompanionPlaneHealth) => {
        eventReady = health.events === "ready"
        if (health.rpc === "unauthenticated") {
          updateRuntimeSnapshot({ connectionState: "offline" })
          return
        }
        if (!eventReady || health.rpc !== "ready") {
          if (completedRecovery) needsManifestRefresh = true
          updateRuntimeSnapshot({ connectionState: "connecting" })
          if (eventReady && health.rpc === "unavailable") scheduleRecovery()
          return
        }
        recover()
      }

      cleanup.push(planeTransport.onPlaneHealthChange(applyPlaneHealth))
      applyPlaneHealth(planeTransport.getPlaneHealth())
    })()

    return () => {
      unregisterSubscriptionStopper()
      disposeSubscriptions()
    }
  }, [platform, configRevision])

  return <>{children}</>
}

type CompanionConnectionState = "connected" | "reconnecting" | "offline" | "unauthenticated"

interface ConnectionStateTransport {
  getConnectionState(): CompanionConnectionState
  onConnectionStateChange(handler: (state: CompanionConnectionState) => void): () => void
}

interface PlaneHealthTransport {
  getPlaneHealth(): CompanionPlaneHealth
  onPlaneHealthChange(handler: (health: CompanionPlaneHealth) => void): () => void
}

function asConnectionStateTransport(value: unknown): ConnectionStateTransport | null {
  if (
    value &&
    typeof value === "object" &&
    "getConnectionState" in value &&
    typeof value.getConnectionState === "function" &&
    "onConnectionStateChange" in value &&
    typeof value.onConnectionStateChange === "function"
  ) {
    return value as ConnectionStateTransport
  }
  return null
}

function asPlaneHealthTransport(value: unknown): PlaneHealthTransport | null {
  if (
    value &&
    typeof value === "object" &&
    "getPlaneHealth" in value &&
    typeof value.getPlaneHealth === "function" &&
    "onPlaneHealthChange" in value &&
    typeof value.onPlaneHealthChange === "function"
  ) {
    return value as PlaneHealthTransport
  }
  return null
}
