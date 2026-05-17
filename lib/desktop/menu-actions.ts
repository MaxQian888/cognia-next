"use client"

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
import { loggers } from "@/lib/logger"
import { desktop as automation } from "@/lib/automation/client"
import { useChatStore } from "@/stores/chat/chat-store"
import { useUIStore } from "@/stores/ui/ui-store"
import { useSettingsStore } from "@/stores/settings"
import type { AppLanguage, AppSettings, ChatSession } from "@/lib/claude/types"

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
  "go-twin",
  "go-skills",
  "go-plugins",
  "go-agent-teams",
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

/** Static route map for every `go-*` navigation id. */
export const GO_ROUTES: Record<string, string> = {
  "go-inbox": "/inbox/all",
  "go-workflows": "/workflows",
  "go-twin": "/twin",
  "go-skills": "/skills",
  "go-plugins": "/plugins",
  "go-agent-teams": "/agent-teams",
  "go-scheduler": "/scheduler",
  "go-discover": "/discover",
  "go-a2ui": "/a2ui",
  "go-logs": "/logs",
  "go-settings": "/settings",
}

// --------------------------------------------------------------------------
// File menu
// --------------------------------------------------------------------------

export function newChatAction(): void {
  log.info("menu action new-chat")
  useChatStore.getState().clear()
  useUIStore.getState().setSelectedGuild({ kind: "dm" })
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
  router.push("/agent-teams")
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
    const { open: openDialog } = await import("@tauri-apps/plugin-dialog")
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: "Select workspace",
    })
    if (typeof picked === "string") {
      await useSettingsStore.getState().save({ defaultWorkingDir: picked })
    }
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
    return all.slice(0, limit)
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
  dispatchKeyChord("k", { ctrl: true })
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
