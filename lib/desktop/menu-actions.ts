"use client"

import { settingsHref } from "@/lib/settings/deep-link"
import { invoke } from "@tauri-apps/api/core"

/**
 * Pure action helpers for the desktop top-menu surface.
 *
 * Both `title-bar.tsx` (in-app Menubar / hamburger DropdownMenu) and
 * `use-menu-event-router.ts` (subscriber for `menu://<id>` events emitted by
 * the Tauri native menu in `src-tauri/src/menu.rs`) call into this module so
 * the two surfaces stay in lock-step. Each menu id has a single source of
 * truth for its side effect.
 *
 * Stateful pieces (always-on-top, theme radios, language radios) stay outside
 * — they read from `next-themes` / settings store and live with the component
 * that owns the visual state. This module only carries logic that is well
 * defined without component-local state.
 */

import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime"

import { transport } from "@/lib/tauri"
import { getDb } from "@/lib/db/schema"
import { listSessions } from "@/lib/db/sessions"
import { filterExposedSessions } from "@/lib/chat/session-exposure"
import { loggers } from "@cognia/logging"
import { desktop as automation } from "@/lib/automation/client"
import { isMainAppWindow } from "@/lib/pet/window-role"
import { useUIStore } from "@/stores/ui/ui-store"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import type { AppLanguage, AppSettings, ChatSession } from "@cognia/agent-config-types"
import { requestCommandPalette } from "@/lib/shell/command-palette-request"
import { SIDEBAR_NAV_META } from "@/types/shell/sidebar"

const log = loggers.ui

/**
 * Every non-navigation menu id the desktop chrome understands, as a literal
 * tuple so each one stays a distinct member of {@link MenuActionId}. The Go
 * menu's ids are NOT here — they are derived from the navigation catalog in
 * {@link GO_MENU_IDS}, so a new rail destination is reachable from the Go
 * menu without a second hand-kept list.
 */
export const MENU_COMMAND_IDS = [
  // File
  "new-chat",
  "new-workflow",
  "new-agent-team",
  "new-character",
  "open-workspace",
  "open-settings",
  "open-logs",
  "quit",
  // View
  "command-palette",
  "toggle-sidebar",
  "toggle-guild-rail",
  "toggle-status-bar",
  // Added with the shell de-crowding pass. Both panels previously had exactly
  // one entry point — an icon button in the title bar — so on macOS, where the
  // in-window menubar is suppressed, folding those buttons into the Views menu
  // would have left the artifact dock and the terminal unreachable from any
  // menu at all.
  "toggle-right-sidebar",
  "toggle-terminal",
  "reload",
  "toggle-fullscreen",
  "zoom-in",
  "zoom-out",
  "zoom-reset",
  "theme-light",
  "theme-dark",
  "theme-system",
  "language-en",
  "language-zh-cn",
  "toggle-reduce-motion",
  // Tools
  "automation-kill-switch",
  "manage-connectors",
  "manage-mcp-server",
  "plugin-devtools",
  "sidecar-restart",
  "clear-cache",
  // Help
  "keyboard-shortcuts",
  "documentation",
  "about",
] as const

/**
 * A Go-menu id: `go-<destination>`. A template-literal type rather than a
 * literal union because the catalog's ids are plain `string`s — the set of
 * valid values is {@link GO_MENU_IDS}, checked at runtime by
 * {@link isGoMenuId}.
 */
export type GoMenuId = `go-${string}`

/**
 * Go-menu destinations that are not in the navigation catalog: the two chat
 * guilds (they switch the rail's guild rather than open a route) and the
 * footer Settings button, which the catalog deliberately leaves out.
 */
const GO_MENU_EXTRA_IDS = [
  "go-dms",
  "go-canvas",
  "go-settings",
] as const satisfies readonly GoMenuId[]

/**
 * Every Go-menu id, in menu order: one `go-<id>` per entry of the navigation
 * catalog (`SIDEBAR_NAV_META`, which the desktop shell shows in full), then
 * {@link GO_MENU_EXTRA_IDS}. Rust's `MENU_IDS` and the native Go submenu
 * (`src-tauri/src/menu.rs`) mirror this list; `menu-actions.test.ts` parses
 * `commands.rs` and fails when the two drift.
 */
export const GO_MENU_IDS: readonly GoMenuId[] = [
  ...SIDEBAR_NAV_META.map((meta): GoMenuId => `go-${meta.id}`),
  ...GO_MENU_EXTRA_IDS,
]

const GO_MENU_ID_SET: ReadonlySet<string> = new Set(GO_MENU_IDS)

/**
 * True when `id` is one of {@link GO_MENU_IDS}. Membership, not a prefix
 * test: `go-anything` is not a destination just because it is spelled like
 * one.
 */
export function isGoMenuId(id: string): id is GoMenuId {
  return GO_MENU_ID_SET.has(id)
}

export type MenuActionId = (typeof MENU_COMMAND_IDS)[number] | GoMenuId

/**
 * Authoritative list of every menu id the desktop chrome understands —
 * {@link MENU_COMMAND_IDS} plus the derived {@link GO_MENU_IDS}. Kept here
 * (rather than spread across components / Rust) so the Tauri menu
 * definition, the in-app Menubar, the router hook and the tests can all
 * iterate the same set.
 */
export const MENU_ACTION_IDS: readonly MenuActionId[] = [...MENU_COMMAND_IDS, ...GO_MENU_IDS]

/**
 * Report shape returned by {@link verifyMenuActionParity}. `missingInRust` /
 * `missingInRenderer` are disjoint — an id only appears in one list. An
 * empty report ({ missingInRust: [], missingInRenderer: [] }) means the two
 * sides agree on every id (excluding the renderer-only `quit` / `about` /
 * zoom / fullscreen ids that Rust handles via PredefinedMenuItem, and the
 * Rust-only `toggle-devtools`).
 */
export interface MenuActionParityReport {
  missingInRust: string[]
  missingInRenderer: string[]
}

/**
 * Renderer-only menu ids — these are handled in-app (zoom via keyboard
 * shortcuts, fullscreen via `getCurrentWindow().setFullscreen`, quit / about
 * via the OS-provided predefined items). Rust's `MENU_IDS` deliberately
 * omits them; the parity check below excludes them too.
 */
export const RENDERER_ONLY_IDS: ReadonlySet<string> = new Set([
  "quit",
  "about",
  "toggle-fullscreen",
  "zoom-in",
  "zoom-out",
  "zoom-reset",
])

/**
 * Rust-only menu ids — `toggle-devtools` opens the webview inspector, which
 * only the Rust side can reach, so `src-tauri/src/menu.rs` handles it inline
 * and never emits `menu://toggle-devtools`. It sits in Rust's `MENU_IDS` but
 * has no renderer action, and the parity check must not report it as drift.
 */
export const RUST_ONLY_IDS: ReadonlySet<string> = new Set(["toggle-devtools"])

/**
 * Compare {@link MENU_ACTION_IDS} against Rust's `menu_action_ids` command
 * and return a diff. Boot-time hook can fail-fast on a non-empty diff so any
 * Rust ↔ renderer drift is caught before a user clicks a menu item that
 * silently no-ops.
 *
 * Returns `null` outside Tauri (web mode never builds the native menu) and
 * on IPC failure — callers should treat both as "skip the check".
 *
 * Rust side: `src-tauri/src/commands.rs:menu_action_ids`.
 */
export async function verifyMenuActionParity(): Promise<MenuActionParityReport | null> {
  try {
    const rustIds = await invoke<string[]>("menu_action_ids")
    if (!Array.isArray(rustIds)) return null
    const rustSet = new Set<string>(rustIds)
    const rendererSet = new Set<string>(MENU_ACTION_IDS)
    const missingInRust: string[] = []
    for (const id of rendererSet) {
      if (RENDERER_ONLY_IDS.has(id)) continue
      if (!rustSet.has(id)) missingInRust.push(id)
    }
    const missingInRenderer: string[] = []
    for (const id of rustSet) {
      if (RUST_ONLY_IDS.has(id)) continue
      if (!rendererSet.has(id)) missingInRenderer.push(id)
    }
    return { missingInRust, missingInRenderer }
  } catch {
    // Not in Tauri, or IPC layer unavailable — skip silently. The
    // tauri-provider hook treats `null` as "no parity check ran".
    return null
  }
}

/**
 * Go destinations whose menu route differs from the catalog route. `go-inbox`
 * has always opened the "all" view directly rather than `/inbox`, which lands
 * on whatever filter the page defaults to.
 */
const GO_ROUTE_OVERRIDES: Readonly<Record<string, string>> = {
  "go-inbox": "/inbox/all",
}

/**
 * Route for every routable `go-*` id: the catalog route (or its
 * {@link GO_ROUTE_OVERRIDES} entry) plus `go-settings`. `go-dms` / `go-canvas`
 * are absent on purpose — they switch the rail's chat guild and land on `/`,
 * see {@link goAction}.
 */
export const GO_ROUTES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    SIDEBAR_NAV_META.map((meta) => {
      const id = `go-${meta.id}`
      return [id, GO_ROUTE_OVERRIDES[id] ?? meta.route]
    })
  ),
  "go-settings": "/settings",
}

// --------------------------------------------------------------------------
// File menu
// --------------------------------------------------------------------------

/**
 * Cmd+N / File → New Chat / tray. Navigates to the welcome surface on the DM
 * scope — the same place every in-app "New chat" lands. The conversation is
 * only created when the user sends from there, so this is idempotent.
 *
 * Main-window only. Rust broadcasts `menu://*` / `tray://*` to EVERY window
 * (`app.emit`), and the pet overlay / popup / island load this same root
 * layout, so their subscribers run this too. Navigation is harmless in the
 * overlay windows' own store instances, but the guard keeps the intent
 * scoped to the window the user actually typed in.
 */
export function newChatAction(): void {
  if (!isMainAppWindow()) return
  log.info("menu action new-chat → welcome")
  useUIStore.getState().requestChatHome({ kind: "dm" })
}

export function newWorkflowAction(router: AppRouterInstance): void {
  log.info("menu action new-workflow")
  // The library page observes `pendingCreateRequest` and opens its create
  // dialog when kind === "workflow". Navigation here just makes sure the
  // user is on the page that owns the dialog.
  useUIStore.getState().requestCreate("workflow")
  router.push("/workflows")
}

export function newAgentTeamAction(router: AppRouterInstance): void {
  log.info("menu action new-agent-team")
  useUIStore.getState().requestCreate("agentTeam")
  // Creating a Squad lives in Settings now, with the other cross-conversation
  // assets. `/squads` answers "what is running" and has no create surface, so
  // routing there would leave the signal with nobody to consume it.
  router.push(settingsHref("squads"))
}

export function newCharacterAction(router: AppRouterInstance): void {
  log.info("menu action new-character")
  // Open the Characters settings tab and signal "create" — the characters
  // panel listens for `pendingCreateRequest` and pops its editor.
  useUIStore.getState().requestCreate("character")
  router.push("/settings?section=characters")
}

export async function openWorkspaceAction(): Promise<void> {
  log.info("menu action open-workspace")
  try {
    // Unified flow: pick a folder and create/activate a real workspace Project
    // (visible in the switcher, binds the Git panel + agent cwd). The old
    // `defaultWorkingDir`-only write was shadowed by the active workspace root.
    const { openFolderAsWorkspace } = await import("@/lib/workspace/open-folder")
    await openFolderAsWorkspace()
  } catch (err) {
    log.warn("menu action open-workspace failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function openSettingsAction(router: AppRouterInstance, section?: string): void {
  log.info("menu action open-settings", { section: section ?? "general" })
  router.push(section ? `/settings?section=${section}` : "/settings")
}

export function openLogsAction(router: AppRouterInstance): void {
  log.info("menu action open-logs")
  router.push("/logs")
}

export async function quitAction(): Promise<void> {
  log.info("menu action quit")
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window")
    await getCurrentWindow().close()
  } catch (err) {
    log.warn("menu action quit failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Most recent sessions, capped at `limit`. Caller is responsible for routing on click. */
export async function loadRecentSessions(limit = 8): Promise<ChatSession[]> {
  try {
    const all = await listSessions()
    return filterExposedSessions(all, "main-list").slice(0, limit)
  } catch (err) {
    log.warn("menu action loadRecentSessions failed", {
      error: err instanceof Error ? err.message : String(err),
    })
    return []
  }
}

// --------------------------------------------------------------------------
// View menu
// --------------------------------------------------------------------------

export function dispatchKeyChord(key: string, mods: { ctrl?: boolean; shift?: boolean }): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      ctrlKey: mods.ctrl ?? false,
      shiftKey: mods.shift ?? false,
    })
  )
}

export function commandPaletteAction(): void {
  log.info("menu action command-palette")
  // Ask the palette directly rather than forging Ctrl+K: on macOS the palette
  // listened for ⌘K, so the forged chord opened nothing (ADR-0129).
  requestCommandPalette()
}

export function toggleSidebarAction(): void {
  log.info("menu action toggle-sidebar")
  useUIStore.getState().toggleSidebar()
}

export function toggleGuildRailAction(): void {
  log.info("menu action toggle-guild-rail")
  useUIStore.getState().toggleGuildRail()
}

export function toggleStatusBarAction(): void {
  log.info("menu action toggle-status-bar")
  useUIStore.getState().toggleStatusBar()
}

export function toggleRightSidebarAction(): void {
  log.info("menu action toggle-right-sidebar")
  useArtifactDockLayoutStore.getState().toggleDock()
}

export function toggleTerminalAction(): void {
  log.info("menu action toggle-terminal")
  useTerminalStore.getState().togglePanel()
}

export function reloadAction(): void {
  log.info("menu action reload")
  if (typeof window !== "undefined") window.location.reload()
}

export async function toggleFullscreenAction(): Promise<void> {
  log.info("menu action toggle-fullscreen")
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window")
    const win = getCurrentWindow()
    const fs = await win.isFullscreen()
    await win.setFullscreen(!fs)
  } catch (err) {
    log.error("menu action toggle-fullscreen failed", err)
  }
}

export async function setThemeAction(
  setTheme: (theme: "light" | "dark" | "system") => void,
  saveSettings: (patch: { theme: "light" | "dark" | "system" }) => Promise<void>,
  theme: "light" | "dark" | "system"
): Promise<void> {
  log.info("menu action set-theme", { theme })
  setTheme(theme)
  try {
    await saveSettings({ theme })
  } catch (err) {
    log.warn("menu action set-theme persist failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export async function setLanguageAction(
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>,
  language: AppLanguage
): Promise<void> {
  log.info("menu action set-language", { language })
  try {
    await saveSettings({ language })
  } catch (err) {
    log.warn("menu action set-language persist failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export async function toggleReduceMotionAction(
  current: boolean,
  saveSettings: (patch: { reduceMotion: boolean }) => Promise<void>
): Promise<void> {
  log.info("menu action toggle-reduce-motion", { from: current })
  try {
    await saveSettings({ reduceMotion: !current })
  } catch (err) {
    log.warn("menu action toggle-reduce-motion persist failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// --------------------------------------------------------------------------
// Go menu
// --------------------------------------------------------------------------

/**
 * Navigate for a Go-menu id. Any other id — or a `go-` spelling that is not
 * in {@link GO_MENU_IDS} — is ignored, so callers can pass a
 * {@link MenuActionId} without pre-filtering.
 */
export function goAction(router: AppRouterInstance, id: MenuActionId): void {
  if (!isGoMenuId(id)) return
  log.info("menu action go", { id })
  if (id === "go-dms") {
    useUIStore.getState().setSelectedGuild({ kind: "dm" })
    router.push("/")
    return
  }
  if (id === "go-canvas") {
    useUIStore.getState().setSelectedGuild({ kind: "canvas" })
    router.push("/")
    return
  }
  const route = GO_ROUTES[id]
  if (route) router.push(route)
}

// --------------------------------------------------------------------------
// Tools menu
// --------------------------------------------------------------------------

export async function automationKillSwitchAction(): Promise<void> {
  log.info("menu action automation-kill-switch")
  await automation.killSwitch()
}

export function manageConnectorsAction(router: AppRouterInstance): void {
  log.info("menu action manage-connectors")
  // The settings shell registers this tab as `connections` (see
  // `components/settings/settings-shell.tsx`); the original "connectors"
  // branding never made it to the URL.
  router.push("/settings?section=connections")
}

export function manageMcpServerAction(router: AppRouterInstance): void {
  log.info("menu action manage-mcp-server")
  router.push("/settings?section=external-bridge")
}

export function pluginDevtoolsAction(router: AppRouterInstance): void {
  log.info("menu action plugin-devtools")
  // Open the Plugins settings tab. The per-plugin DevTools panel is reached
  // from each plugin card's actions menu — there is no global "open all
  // devtools" route, so the menu item lands the user one click away.
  router.push("/settings?section=plugins")
}

export async function restartSidecarAction(): Promise<void> {
  log.info("menu action sidecar-restart")
  await transport.call<void>("claude_restart_sidecar", {})
}

/**
 * Clear known transient caches: the Open VSX metadata cache (24h TTL, safe to
 * drop) and any Service Worker `Cache` storage entries. Conversations,
 * settings, and message history are intentionally untouched.
 */
export async function clearCacheAction(): Promise<void> {
  log.info("menu action clear-cache")
  const errors: string[] = []

  try {
    const db = getDb()
    await db.openVsxCache.clear()
  } catch (err) {
    errors.push(`openVsxCache: ${err instanceof Error ? err.message : String(err)}`)
  }

  try {
    if (typeof caches !== "undefined") {
      const names = await caches.keys()
      await Promise.all(names.map((name) => caches.delete(name)))
    }
  } catch (err) {
    errors.push(`caches API: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (errors.length > 0) {
    log.warn("menu action clear-cache partial", { errors })
    throw new Error(errors.join("; "))
  }
}

// --------------------------------------------------------------------------
// Help menu
// --------------------------------------------------------------------------

export async function documentationAction(): Promise<void> {
  log.info("menu action documentation")
  try {
    const { openExternal } = await import("@/lib/tauri/opener")
    await openExternal("https://v2.tauri.app")
  } catch (err) {
    log.error("menu action documentation failed", err)
  }
}

export function aboutAction(router: AppRouterInstance): void {
  log.info("menu action about")
  router.push("/settings?section=about")
}
