"use client"

/**
 * Subscribes to the `menu://<id>` events emitted by the Tauri native menu
 * (see `src-tauri/src/menu.rs`) and routes them to the same action helpers
 * the in-app Menubar uses (`lib/desktop/menu-actions.ts`).
 *
 * Mounted once at the desktop shell level so menu events keep firing even
 * on routes where the in-app Menubar is rendered in its hamburger form, or
 * where the title bar is suppressed.
 */

import { useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import { useEffect, useRef } from "react"

import { isTauri } from "@/lib/tauri"
import { onTauriEvent, TAURI_EVENTS } from "@/lib/tauri/events"
import { loggers } from "@/lib/logger"
import { useSettingsStore } from "@/stores/settings"
import {
  aboutAction,
  automationKillSwitchAction,
  clearCacheAction,
  commandPaletteAction,
  documentationAction,
  goAction,
  manageConnectorsAction,
  manageMcpServerAction,
  MENU_ACTION_IDS,
  newAgentTeamAction,
  newChatAction,
  newCharacterAction,
  newWorkflowAction,
  openLogsAction,
  openSettingsAction,
  openWorkspaceAction,
  pluginDevtoolsAction,
  quitAction,
  reloadAction,
  restartSidecarAction,
  setLanguageAction,
  setThemeAction,
  toggleFullscreenAction,
  toggleGuildRailAction,
  toggleReduceMotionAction,
  toggleSidebarAction,
  toggleStatusBarAction,
  type MenuActionId,
} from "@/lib/desktop/menu-actions"

const log = loggers.ui

/**
 * Menu ids the native menu does NOT need a renderer-side subscriber for:
 *   • `toggle-fullscreen` / `reload` / `toggle-devtools` are intercepted in
 *     menu.rs (Rust toggles them directly).
 *   • `quit` is delivered via the OS predefined menu item, never as
 *     `menu://quit`.
 *   • `zoom-*` is handled by the title bar's ZoomShortcuts component; the
 *     native menu doesn't emit `menu://zoom-*` because the OS chord wins
 *     before the dispatch runs.
 * Anything listed here is silently ignored if the Rust side ever emits it.
 */
const SKIP_NATIVE: ReadonlySet<MenuActionId> = new Set<MenuActionId>([
  "reload",
  "toggle-fullscreen",
  "zoom-in",
  "zoom-out",
  "zoom-reset",
])

export interface UseMenuEventRouterOptions {
  /**
   * Read by the router when the user picks "Keyboard Shortcuts…" from the
   * native Help menu. Optional — the in-app Menubar's onSelect path already
   * surfaces the dialog through its own state.
   */
  onShowKeyboardShortcuts?: () => void
  /**
   * Hook for the always-on-top toggle. The Window-menu surface in the title
   * bar owns the boolean; the router needs to delegate back to it.
   */
  onToggleAlwaysOnTop?: () => Promise<void> | void
}

export function useMenuEventRouter(options: UseMenuEventRouterOptions = {}): void {
  const router = useRouter()
  const { setTheme } = useTheme()
  const optionsRef = useRef(options)
  // eslint-disable-next-line react-hooks/refs -- WIP: sync ref during render so the next render's effect captures latest options. Standard pattern for ref-tracked callbacks; refactor to useEffect+ref-sync if it surfaces a render bug.
  optionsRef.current = options

  useEffect(() => {
    if (!isTauri()) return

    let cancelled = false
    const unlisteners: Array<() => void> = []

    const handleId = async (id: MenuActionId): Promise<void> => {
      const saveSettings = useSettingsStore.getState().save
      const settings = useSettingsStore.getState().settings
      const reduceMotionCurrent = settings?.reduceMotion ?? false
      try {
        switch (id) {
          case "new-chat":
            newChatAction()
            break
          case "new-workflow":
            newWorkflowAction(router)
            break
          case "new-agent-team":
            newAgentTeamAction(router)
            break
          case "new-character":
            newCharacterAction(router)
            break
          case "open-workspace":
            await openWorkspaceAction()
            break
          case "open-settings":
            openSettingsAction(router)
            break
          case "open-logs":
          case "go-logs":
            openLogsAction(router)
            break
          case "quit":
            await quitAction()
            break
          case "command-palette":
            commandPaletteAction()
            break
          case "toggle-sidebar":
            toggleSidebarAction()
            break
          case "toggle-guild-rail":
            toggleGuildRailAction()
            break
          case "toggle-status-bar":
            toggleStatusBarAction()
            break
          case "reload":
            reloadAction()
            break
          case "toggle-fullscreen":
            await toggleFullscreenAction()
            break
          case "theme-light":
            await setThemeAction(setTheme, saveSettings, "light")
            break
          case "theme-dark":
            await setThemeAction(setTheme, saveSettings, "dark")
            break
          case "theme-system":
            await setThemeAction(setTheme, saveSettings, "system")
            break
          case "language-en":
            await setLanguageAction(saveSettings, "en")
            break
          case "language-zh-cn":
            await setLanguageAction(saveSettings, "zh-CN")
            break
          case "toggle-reduce-motion":
            await toggleReduceMotionAction(reduceMotionCurrent, saveSettings)
            break
          case "go-inbox":
          case "go-workflows":
          case "go-twin":
          case "go-skills":
          case "go-plugins":
          case "go-agent-teams":
          case "go-scheduler":
          case "go-discover":
          case "go-a2ui":
          case "go-dms":
          case "go-canvas":
          case "go-settings":
            goAction(router, id)
            break
          case "automation-kill-switch":
            await automationKillSwitchAction()
            break
          case "manage-connectors":
            manageConnectorsAction(router)
            break
          case "manage-mcp-server":
            manageMcpServerAction(router)
            break
          case "plugin-devtools":
            pluginDevtoolsAction(router)
            break
          case "sidecar-restart":
            await restartSidecarAction()
            break
          case "clear-cache":
            await clearCacheAction()
            break
          case "keyboard-shortcuts":
            optionsRef.current.onShowKeyboardShortcuts?.()
            break
          case "documentation":
            await documentationAction()
            break
          case "about":
            aboutAction(router)
            break
          case "zoom-in":
          case "zoom-out":
          case "zoom-reset":
            // Zoom is handled by ZoomShortcuts; no-op from the menu side.
            break
          default: {
            const _exhaustive: never = id
            void _exhaustive
          }
        }
      } catch (err) {
        log.warn("menu event-router handler failed", {
          id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    const subscribe = async () => {
      // Tray channels are first-party — keep them wired even though they
      // duplicate menu://open-logs etc.
      const tray = (async () => {
        try {
          const u = await onTauriEvent<unknown>(TAURI_EVENTS.trayOpenLogs, () => {
            void handleId("open-logs")
          })
          if (cancelled) u()
          else unlisteners.push(u)
        } catch (err) {
          log.warn("menu event-router subscribe trayOpenLogs failed", {
            error: err instanceof Error ? err.message : String(err),
          })
        }
      })()

      const menus = MENU_ACTION_IDS.filter((id) => !SKIP_NATIVE.has(id)).map(async (id) => {
        try {
          const u = await onTauriEvent<unknown>(`${TAURI_EVENTS.menuPrefix}${id}`, () => {
            void handleId(id)
          })
          if (cancelled) {
            u()
          } else {
            unlisteners.push(u)
          }
        } catch (err) {
          log.warn("menu event-router subscribe failed", {
            id,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      })

      await Promise.all([tray, ...menus])
    }

    void subscribe()

    return () => {
      cancelled = true
      for (const u of unlisteners) {
        try {
          u()
        } catch {
          /* unlisteners are best-effort */
        }
      }
    }
  }, [router, setTheme])
}
