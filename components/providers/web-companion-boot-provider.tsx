"use client"

import { usePathname, useRouter } from "next/navigation"
import { useEffect, useRef, useState } from "react"

import { usePlatform } from "@/hooks/use-platform"
import { getActiveBrowserVault } from "@/lib/runtime/browser-vault"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"
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
  runSyncDown,
} from "@/lib/sync/companion-sync"
import { hydrateCompanionConfig } from "@/lib/tauri/transport-companion"
import type { CompanionPlaneHealth } from "@/lib/tauri/transport-companion"
import { remoteEventResyncCoordinator } from "@/lib/tauri/resync-coordinator"
import { transport } from "@/lib/tauri"
import { loggers } from "@cognia/logging"
import {
  notifyWebHostBindingsFailed,
  notifyWebHostBindingsReady,
  registerWebHostBindingOwner,
} from "@/lib/companion/web-host-binding-lifecycle"

const log = loggers.shell

// The pair flow owns navigation on these routes — never redirect from them.
const ONBOARDING_PREFIXES = ["/welcome", "/pair", "/oauth"]
const RECOVERY_BACKOFF_MS = [250, 1_000, 4_000, 16_000, 30_000] as const

/**
 * Cloud-companion boot for the PLAIN BROWSER (ADR-0059 C1).
 *
 * The web build becomes a thin client of a cognia-server when
 * `hasWebCompanionTarget()` is true (build-time server URL or an existing
 * pairing). This is the browser sibling of `CompanionBootProvider` minus
 * everything Capacitor: no native plugins, no push, no deeplinks, no status
 * bar — just config hydration, the unpaired→/pair redirect, and the sync
 * installers (which are webview-agnostic).
 *
 * No-op on Tauri (the desktop IS the server) and on Capacitor (the mobile
 * provider owns boot there). Also a no-op on web-standalone — a browser with
 * no server target keeps the BYOK stub behavior.
 */
export function WebCompanionBootProvider({ children }: { children: React.ReactNode }) {
  const platform = usePlatform()
  const router = useRouter()
  const pathname = usePathname()
  const pathnameRef = useRef(pathname)
  const [configRevision, setConfigRevision] = useState(0)

  useEffect(() => {
    pathnameRef.current = pathname
  }, [pathname])

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
    const vaultState = getActiveBrowserVault() ? "unlocked" : "locked"
    if (!companionConfigured) {
      setRuntimeSnapshot({
        target: { id: "web-standalone", kind: "standalone", platform: "web" },
        vaultState,
        connectionState: "online",
      })
      return
    }

    setRuntimeSnapshot({
      target: {
        id: "web-companion",
        kind: "companion",
        platform: "web",
        hostKind: "cloud",
      },
      vaultState,
      connectionState: "connecting",
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
        notifyWebHostBindingsFailed(new Error("The selected Web Host credential is unavailable."))
        updateRuntimeSnapshot({
          vaultState: getActiveBrowserVault() ? "unlocked" : "unavailable",
          connectionState: "offline",
          host: undefined,
        })
        const onOnboarding = ONBOARDING_PREFIXES.some((p) => pathnameRef.current.startsWith(p))
        if (!onOnboarding) {
          log.info("web companion: server configured but unpaired — redirecting to /pair")
          router.replace("/pair")
        }
        return
      }

      updateRuntimeSnapshot({
        target: {
          id: config.targetId ?? "web-companion",
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
        updateRuntimeSnapshot({ host: runtimeHostSnapshotFromManifest(manifest) })
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
            updateRuntimeSnapshot({ connectionState: "connecting" })
            log.warn("web companion: host manifest unavailable", {
              error: error instanceof Error ? error.message : String(error),
            })
            const base =
              RECOVERY_BACKOFF_MS[Math.min(recoveryAttempt, RECOVERY_BACKOFF_MS.length - 1)]
            recoveryAttempt++
            await new Promise<void>((resolve) => {
              recoveryTimer = setTimeout(
                () => {
                  recoveryTimer = null
                  resolve()
                },
                Math.round(base * (0.85 + Math.random() * 0.3))
              )
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
        })
      )
      // Subscribe before the authoritative sync so invalidations cannot fall
      // into a sync-complete/subscription-not-yet-open race window.
      cleanup.push(installEventDrivenSync())

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
          await runSyncDown()
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
  }, [platform, router, configRevision])

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
