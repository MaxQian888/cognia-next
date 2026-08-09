"use client"

import dynamic from "next/dynamic"
import { useEffect, useSyncExternalStore } from "react"

import {
  getBootCapabilitySnapshot,
  isBootCapabilityRequested,
  markBootCapabilityReady,
  subscribeBootCapabilities,
} from "@/lib/boot/capabilities"
import { isTauri } from "@/lib/native/utils"
import { getPetWindowRole, isSecondaryOverlayRole } from "@/lib/pet/window-role"

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
// NOTE: WindowShowInitializer + WebviewHeartbeatInitializer used to live here,
// but this whole bundle mounts *below* AccountGate — so on a locked/first-run
// cold boot (the common case) they never ran and the hidden window stayed black
// until the Rust 8s force-show fallback. They now mount in
// `WindowLivenessInitializers`, above the account gate. See that component.
const CodexUsageSchedulerInitializer = dynamic(
  () => import("./codex-usage-scheduler-initializer").then((m) => m.CodexUsageSchedulerInitializer),
  { ssr: false }
)
const AnthropicUsageSchedulerInitializer = dynamic(
  () =>
    import("./anthropic-usage-scheduler-initializer").then(
      (m) => m.AnthropicUsageSchedulerInitializer
    ),
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
const EditorLspRuntimeInitializer = dynamic(
  () => import("./editor-lsp-runtime-initializer").then((m) => m.EditorLspRuntimeInitializer),
  { ssr: false }
)
const ManagedIdeBrokerInitializer = dynamic(
  () => import("./managed-ide-broker-initializer").then((m) => m.ManagedIdeBrokerInitializer),
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
const FleetHistorySinkInitializer = dynamic(
  () => import("./fleet-history-sink-initializer").then((m) => m.FleetHistorySinkInitializer),
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
const SelectionToolbarInitializer = dynamic(
  () => import("./selection-toolbar-initializer").then((m) => m.SelectionToolbarInitializer),
  { ssr: false }
)
const TrayPanelInitializer = dynamic(
  () => import("./tray-panel-initializer").then((m) => m.TrayPanelInitializer),
  { ssr: false }
)

export function DesktopOnlyInitializers() {
  const isClient = useIsClient()
  useSyncExternalStore(
    subscribeBootCapabilities,
    getBootCapabilitySnapshot,
    getBootCapabilitySnapshot
  )
  const requested = isBootCapabilityRequested("desktop-tools")
  const tauri = isClient && isTauri()
  const role = isClient ? getPetWindowRole() : "web"
  const secondary = isSecondaryOverlayRole(role)

  useEffect(() => {
    if (requested && isClient && !secondary) markBootCapabilityReady("desktop-tools")
  }, [isClient, requested, secondary])

  if (!isClient || !requested || !tauri) return null

  // The transparent desktop-pet windows (sprite overlay + click popup) load this
  // same root layout, but every initializer bundled here is a MAIN-window boot
  // concern (window show/heartbeat, terminal + CLI bridges, local character-pack
  // disk scan, updater, deep-link routers, exit/crash dialogs). Running them in a
  // pet window is wasted work and actively wrong — e.g. the character-pack scan
  // calls `fs.read_dir`, which the least-privilege pet capabilities deny, logging
  // a spurious warning. Skip the whole bundle there; the pet windows start their
  // own cross-window bridge from the pet view, and need nothing here.
  if (secondary) return null

  return (
    <>
      <CodexUsageSchedulerInitializer />
      <AnthropicUsageSchedulerInitializer />
      <CliSyncInitializer />
      <ComputerUseKillSwitchInitializer />
      <TerminalBridgeInitializer />
      <EditorLspRuntimeInitializer />
      <ManagedIdeBrokerInitializer />
      <LocalCharacterPackInitializer />
      <PetWindowInitializer />
      <FleetHistorySinkInitializer />
      <UpdateCheckInitializer />
      <PluginDeepLinkRouter />
      <ConsentOverlay />
      <CliBridgeEventsBridge />
      <ExitConfirmationDialog />
      <CrashReportDialog />
      <SelectionToolbarInitializer />
      <TrayPanelInitializer />
    </>
  )
}

export default DesktopOnlyInitializers
