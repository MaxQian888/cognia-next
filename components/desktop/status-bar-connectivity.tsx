"use client"

/**
 * Status-bar connectivity segment. Reuses the reactive network hook
 * (`useNetworkStatus`, online/offline via window events on desktop) and layers
 * the companion transport's connection tier (`useConnectionState`) when present
 * — on plain Tauri desktop the latter is `null`, so the network flag drives it.
 * Click opens the Companion settings section. Mounting is gated by the parent
 * (`barItems.connectivity`); this component always renders a state when mounted.
 */

import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { RefreshCwIcon, WifiIcon, WifiOffIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { useNetworkStatus } from "@/hooks/use-network-status"
import { useConnectionState } from "@/hooks/companion/use-connection-state"
import { usePlatform } from "@/hooks/use-platform"
import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import { resolveOperationAvailability } from "@/lib/runtime/operation-availability"
import { resolveRuntimeRecovery } from "@/lib/runtime/recovery-resolver"
import { useUIStore } from "@/stores/ui/ui-store"

type ConnState = "online" | "offline" | "reconnecting"

export function StatusBarConnectivity() {
  const t = useTranslations("desktop.statusBar")
  const router = useRouter()
  const platform = usePlatform()
  const runtimeSnapshot = useRuntimeSnapshot()
  const requestOpenSettings = useUIStore((s) => s.requestOpenSettings)
  const { status } = useNetworkStatus()
  const connection = useConnectionState()

  // No network wins; otherwise reflect the companion transport tier if it
  // exposes one; otherwise we're online.
  const state: ConnState = !status.connected
    ? "offline"
    : connection === "reconnecting"
      ? "reconnecting"
      : connection === "offline" || connection === "unauthenticated"
        ? "offline"
        : "online"

  const label =
    state === "offline"
      ? t("connOffline")
      : state === "reconnecting"
        ? t("connReconnecting")
        : t("connOnline")

  const Icon =
    state === "offline" ? WifiOffIcon : state === "reconnecting" ? RefreshCwIcon : WifiIcon

  const operationAvailability = resolveOperationAvailability({
    snapshot: runtimeSnapshot,
    command: "claude_send",
    localExecutorAvailable: runtimeSnapshot.target?.kind === "standalone",
    readOnlyFallback: false,
  })
  const recovery = resolveRuntimeRecovery(
    state === "offline"
      ? { state: "offline", reason: "connection-offline" }
      : operationAvailability,
    platform
  )

  const openConnectivity = () => {
    if (recovery.kind === "route") {
      router.push(recovery.href)
      return
    }
    if (recovery.kind === "local-settings" || platform === "tauri") {
      requestOpenSettings("companion")
      return
    }
    if (runtimeSnapshot.target?.kind === "companion") {
      router.push("/pair?mode=recover")
    }
  }

  return (
    <button
      type="button"
      onClick={openConnectivity}
      aria-label={label}
      title={label}
      data-testid="status-connectivity"
      className="flex h-6 shrink-0 items-center gap-1 px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <Icon
        aria-hidden
        className={cn(
          "size-3",
          state === "reconnecting" && "animate-spin text-amber-500",
          state === "offline" && "text-rose-500",
          state === "online" && "text-emerald-500"
        )}
      />
      <span className="hidden lg:inline">{label}</span>
    </button>
  )
}
