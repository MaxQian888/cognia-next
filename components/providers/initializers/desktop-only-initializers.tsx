"use client"

import dynamic from "next/dynamic"
import { useSyncExternalStore } from "react"

import { isTauri } from "@/lib/native/utils"

/**
 * Client-mount probe via `useSyncExternalStore` (not `useState` + effect, which
 * the repo's `react-hooks/set-state-in-effect` lint forbids). The server
 * snapshot is `false` and the client snapshot is `true`, so the first client
 * render matches the prerendered server output (`null`) and only flips to the
 * gated subtree after hydration — no divergence on the shared `out/` bundle.
 */
const emptySubscribe = () => () => {}

function useIsClient(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  )
}

/**
 * Desktop-only boot initializers, consolidated behind a single runtime Tauri
 * gate.
 *
 * Each child below already no-ops on web / Capacitor (it self-gates on
 * `isTauri()` / native bridges and renders `null`), so they were previously
 * mounted unconditionally in `app/layout.tsx` and statically imported. That
 * pulled their entire subsystem module graphs (terminal bridge, computer-use
 * kill switch, connector/plugin deep-link routers, CLI bridge, updater, pet
 * window, codex usage, crash/exit dialogs, automation consent) into the root
 * layout's eager graph — which the dev server must compile to render *any*
 * page, a primary driver of `pnpm dev` memory.
 *
 * Here they are `next/dynamic(ssr: false)` imports rendered only when
 * `isTauri()` is true. On the browser dev server the gate is false, so the
 * loaders never fire, so Turbopack never fetches — and therefore never
 * compiles — these chunks. `next build` still statically emits every chunk
 * into `out/`, so the Tauri desktop build loads them at runtime exactly as
 * before. Capacitor (also non-Tauri) keeps skipping them, which is correct —
 * they are desktop-only.
 *
 * The mounted guard makes the first client render match the server (both
 * `null`), so the shared static-export bundle hydrates without divergence
 * whether it boots in the browser, Tauri, or the Capacitor WebView.
 */
const WindowShowInitializer = dynamic(
  () => import("./window-show-initializer").then((m) => m.WindowShowInitializer),
  { ssr: false }
)
const WebviewHeartbeatInitializer = dynamic(
  () => import("./webview-heartbeat-initializer").then((m) => m.WebviewHeartbeatInitializer),
  { ssr: false }
)
const CodexUsageSchedulerInitializer = dynamic(
  () => import("./codex-usage-scheduler-initializer").then((m) => m.CodexUsageSchedulerInitializer),
  { ssr: false }
)
const CliSyncInitializer = dynamic(
  () => import("./cli-sync-initializer").then((m) => m.CliSyncInitializer),
  { ssr: false }
)
const ComputerUseKillSwitchInitializer = dynamic(
  () =>
    import("./computer-use-kill-switch-initializer").then(
      (m) => m.ComputerUseKillSwitchInitializer
    ),
  { ssr: false }
)
const TerminalBridgeInitializer = dynamic(
  () => import("./terminal-bridge-initializer").then((m) => m.TerminalBridgeInitializer),
  { ssr: false }
)
const LocalCharacterPackInitializer = dynamic(
  () => import("./local-character-pack-initializer").then((m) => m.LocalCharacterPackInitializer),
  { ssr: false }
)
const PetWindowInitializer = dynamic(
  () => import("./pet-window-initializer").then((m) => m.PetWindowInitializer),
  { ssr: false }
)
const UpdateCheckInitializer = dynamic(
  () => import("./update-check-initializer").then((m) => m.UpdateCheckInitializer),
  { ssr: false }
)
const PluginDeepLinkRouter = dynamic(
  () => import("@/components/plugins/plugin-deep-link-router").then((m) => m.PluginDeepLinkRouter),
  { ssr: false }
)
const ConsentOverlay = dynamic(
  () => import("@/components/automation/consent-overlay").then((m) => m.ConsentOverlay),
  { ssr: false }
)
const CliBridgeEventsBridge = dynamic(
  () => import("@/components/plugins/cli-bridge-events").then((m) => m.CliBridgeEventsBridge),
  { ssr: false }
)
const ExitConfirmationDialog = dynamic(
  () =>
    import("@/components/desktop/exit-confirmation-dialog").then((m) => m.ExitConfirmationDialog),
  { ssr: false }
)
const CrashReportDialog = dynamic(
  () => import("@/components/desktop/crash-report-dialog").then((m) => m.CrashReportDialog),
  { ssr: false }
)

export function DesktopOnlyInitializers() {
  const isClient = useIsClient()
  if (!isClient || !isTauri()) return null

  return (
    <>
      <WindowShowInitializer />
      <WebviewHeartbeatInitializer />
      <CodexUsageSchedulerInitializer />
      <CliSyncInitializer />
      <ComputerUseKillSwitchInitializer />
      <TerminalBridgeInitializer />
      <LocalCharacterPackInitializer />
      <PetWindowInitializer />
      <UpdateCheckInitializer />
      <PluginDeepLinkRouter />
      <ConsentOverlay />
      <CliBridgeEventsBridge />
      <ExitConfirmationDialog />
      <CrashReportDialog />
    </>
  )
}

export default DesktopOnlyInitializers
