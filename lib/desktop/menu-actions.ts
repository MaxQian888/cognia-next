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
import { startNewSession } from "@/lib/chat/start-session"
import { isMainAppWindow } from "@/lib/pet/window-role"
import { useUIStore } from "@/stores/ui/ui-store"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import type { AppLanguage, AppSettings, ChatSession } from "@cognia/agent-config-types"
import { requestCommandPalette } from "@/lib/shell/command-palette-request"

const log = loggers.ui

/**
 * Authoritative list of every menu id the desktop chrome understands. Kept
 * here (rather than spread across components / Rust) so the Tauri menu
 * definition, the in-app Menubar, the router hook and the tests can all
 * iterate the same set.
 */
export const MENU_ACTION_IDS = [
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
  // Go
  "go-inbox",
  "go-workflows",
  "go-sites",
  "go-twin",
  "go-skills",
  "go-plugins",
  "go-squads",
  "go-scheduler",
  "go-discover",
  "go-a2ui",
  "go-dms",
  "go-canvas",
  "go-logs",
  "go-settings",
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

export type MenuActionId = (typeof MENU_ACTION_IDS)[number]

/**
 * Report shape returned by {@link verifyMenuActionParity}. `missingInRust` /
 * `missingInRenderer` are disjoint — an id only appears in one list. An
 * empty report ({ missingInRust: [], missingInRenderer: [] }) means the two
 * sides agree on every id (excluding the renderer-only `quit` / `about` /
 * zoom / fullscreen ids that Rust handles via PredefinedMenuItem).
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
const RENDERER_ONLY_IDS: ReadonlySet<string> = new Set([
  "quit",
  "about",
  "toggle-fullscreen",
  "zoom-in",
  "zoom-out",
  "zoom-reset",
])

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
      if (!rendererSet.has(id)) missingInRenderer.push(id)
    }
    return { missingInRust, missingInRenderer }
  } catch {
    // Not in Tauri, or IPC layer unavailable — skip silently. The
    // tauri-provider hook treats `null` as "no parity check ran".
    return null
  }
}

/** Static route map for every `go-*` navigation id. */
export const GO_ROUTES: Record<string, string> = {
  "go-inbox": "/inbox/all",
  "go-workflows": "/workflows",
  "go-sites": "/sites",
  "go-twin": "/twin",
  "go-skills": "/skills",
  "go-plugins": "/plugins",
  "go-squads": "/squads",
  "go-scheduler": "/scheduler",
  "go-discover": "/discover",
  "go-a2ui": "/a2ui",
  "go-logs": "/logs",
  "go-settings": "/settings",
}

// --------------------------------------------------------------------------
// File menu
// --------------------------------------------------------------------------

/**
 * Cmd+N / File → New Chat / tray. Starts a real conversation rather than
 * clearing to the welcome page: `clear()` dropped every open pane and left the
 * user with no session, so "New Chat" meant something different here than it
 * did for the in-app "+" and the command palette.
 *
 * Main-window only. Rust broadcasts `menu://*` / `tray://*` to EVERY window
 * (`app.emit`), and the pet overlay / popup / island load this same root
 * layout, so their subscribers run this too. Creating a session is not
 * idempotent — without this guard one Cmd+N with the pet overlay open would
 * create two conversations.
 */
export function newChatAction(): void {
  if (!isMainAppWindow()) return
  log.info("menu action new-chat")
  useUIStore.getState().setSelectedGuild({ kind: "dm" })
  void startNewSession()
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

export function goAction(router: AppRouterInstance, id: MenuActionId): void {
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
