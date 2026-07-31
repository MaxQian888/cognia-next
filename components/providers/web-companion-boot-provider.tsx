"use client"

import { usePathname, useRouter } from "next/navigation"
import { useEffect, useRef, useState } from "react"

import { usePlatform } from "@/hooks/use-platform"
import { getActiveBrowserVault } from "@/lib/runtime/browser-vault"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"
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
import { remoteEventResyncCoordinator } from "@/lib/tauri/resync-coordinator"
import { transport } from "@/lib/tauri"
import { loggers } from "@cognia/logging"

const log = loggers.shell

// The pair flow owns navigation on these routes — never redirect from them.
const ONBOARDING_PREFIXES = ["/welcome", "/pair", "/oauth"]

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
    const onConfigChanged = () => setConfigRevision((revision) => revision + 1)
    window.addEventListener("cognia:companion-config-changed", onConfigChanged)
    return () => window.removeEventListener("cognia:companion-config-changed", onConfigChanged)
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

      const loadManifest = async () => {
        try {
          const manifest = await transport.call("host_feature_manifest", {})
          if (cancelled) return
          updateRuntimeSnapshot({
            host: runtimeHostSnapshotFromManifest(manifest),
          })
        } catch (error) {
          if (cancelled) return
          updateRuntimeSnapshot({
            host: { compatible: false, operations: [], grants: [] },
          })
          log.warn("web companion: host manifest unavailable", {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      const statefulTransport = asConnectionStateTransport(transport)
      if (statefulTransport) {
        const applyConnectionState = (state: CompanionConnectionState) => {
          const connectionState = mapConnectionState(state)
          updateRuntimeSnapshot({ connectionState })
          if (connectionState === "online") void loadManifest()
        }
        applyConnectionState(statefulTransport.getConnectionState())
        cleanup.push(statefulTransport.onConnectionStateChange(applyConnectionState))
      } else {
        updateRuntimeSnapshot({ connectionState: "online" })
      }
      await loadManifest()

      try {
        cleanup.push(
          remoteEventResyncCoordinator.register("*", async () => {
            await runSyncDown()
          })
        )
        await runSyncDown()
      } catch (err) {
        log.warn("web companion: initial sync-down failed", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
      if (cancelled) return
      cleanup.push(installForegroundSync())
      cleanup.push(installEventDrivenSync())
      const teardownNetworkSync = await installNetworkSync()
      if (cancelled) {
        teardownNetworkSync()
        return
      }
      cleanup.push(teardownNetworkSync)
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

function mapConnectionState(state: CompanionConnectionState): "online" | "connecting" | "offline" {
  if (state === "connected") return "online"
  if (state === "reconnecting") return "connecting"
  return "offline"
}
