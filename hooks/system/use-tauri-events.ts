"use client"

import { useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { listen } from "@tauri-apps/api/event"
import { TAURI_EVENTS, onTauriEvent, transport } from "@/lib/tauri"
import { emitSchedulerEvent } from "@/lib/scheduler/event-integration"
import { isRemoteHostActive } from "@/lib/tauri/transport-routing"
import { isTauri } from "@/lib/tauri"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"
import { useChatStore } from "@/stores/chat"
import { startNewSession } from "@/lib/chat/start-session"
import { isMainAppWindow } from "@/lib/pet/window-role"
import { useUIStore } from "@/stores/ui"
import { openPathAsWorkspace } from "@/lib/workspace/open-folder"
import { dispatchTrayClick, dispatchShortcut } from "@/lib/tray/dispatcher"
import {
  checkUpdates,
  copyDiagnostics,
  openDataFolder,
  openDocs,
  reportIssue,
  toggleAutostartAction,
} from "@/lib/tray/tray-actions"
import type { TrayActionPayload } from "@/lib/tray/types"
import { parseCogniaDeeplink } from "@/lib/navigation/cognia-deeplink"

function relaySchedulerEvent(
  eventType: "job:exited" | "monitor:fired",
  data: Record<string, unknown>
): Promise<unknown> {
  if (isRemoteHostActive()) {
    return transport.call("scheduled_task_emit_event", { eventType, data })
  }
  return emitSchedulerEvent(eventType, data)
}

/**
 * Subscribes the renderer to events emitted by `src-tauri/src/{lib,tray,menu}.rs`
 * and dispatches them into the existing zustand stores.
 *
 * Mount this once near the root of the app — `tauri-provider.tsx` does that.
 */
export function useTauriEvents(): void {
  const router = useRouter()
  // Tray toasts fire from inside the long-lived setup effect (deps: [router]).
  // Hold the translator in a ref so locale changes don't tear down and rebuild
  // every Tauri listener, while still resolving against the current locale.
  const t = useTranslations("settings.about")
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])

  useEffect(() => {
    if (!isTauri()) return
    const unsubscribers: Array<() => void> = []
    let cancelled = false

    /**
     * The tray menu, View menu, and Ctrl+Shift+L global shortcut all want to
     * surface the Log Panel. They emit different events for traceability but
     * share this single navigator so the destination stays consistent.
     */
    const navigateToLogs = () => {
      router.push("/logs")
    }

    const handleDeepLinks = (urls: string[]) => {
      for (const raw of urls) {
        const action = parseCogniaDeeplink(raw)
        switch (action.kind) {
          case "open_session": {
            if (action.sessionId) {
              useChatStore.getState().setActiveSession(action.sessionId)
              useUIStore.getState().setSelectedGuild({ kind: "dm" })
            }
            break
          }
          case "open_im": {
            if (action.conversationKey) {
              void import("@/lib/connectors/session-bindings")
                .then(({ findActiveSessionForConversation }) =>
                  findActiveSessionForConversation(action.conversationKey!)
                )
                .then((session) => {
                  if (!session) return
                  useChatStore.getState().setActiveSession(session.id)
                  useUIStore.getState().setSelectedGuild({ kind: "dm" })
                })
                .catch(() => undefined)
            }
            break
          }
          case "open_scheduler_task": {
            if (action.taskId) {
              const taskId = action.taskId
              const runToken = action.runToken
              void import("@/stores/scheduler/scheduler-store").then(
                async ({ useSchedulerStore }) => {
                  useSchedulerStore.getState().selectTask(taskId)
                  router.push("/scheduler")
                  // OS-promoted wake-up: only a link carrying the task's own
                  // promotion token may execute; a bare link just navigates.
                  if (runToken) {
                    try {
                      await useSchedulerStore.getState().initialize()
                      const { getTaskScheduler } = await import("@/lib/scheduler/task-scheduler")
                      await getTaskScheduler().runPromotedTask(taskId, runToken)
                    } catch (err) {
                      console.warn("promoted task wake-up failed", { taskId, err })
                    }
                  }
                }
              )
            }
            break
          }
          case "open_settings": {
            useUIStore.getState().requestOpenSettings(action.settingsTab)
            break
          }
          case "open_workspace": {
            // Unified flow: create/activate a real workspace Project for the
            // deep-linked path (consistent with the File menu / switcher).
            if (action.workspacePath) openPathAsWorkspace(action.workspacePath)
            break
          }
          case "open_workflow_run": {
            if (action.workflowId && action.runId) {
              router.push(
                `/workflows/run?id=${encodeURIComponent(action.workflowId)}&runId=${encodeURIComponent(action.runId)}`
              )
            }
            break
          }
          case "oauth_callback":
          case "pair_qr":
          case "share_target": {
            // Mobile-owned routes are parsed here for parity but handled by
            // the Capacitor router when this hook runs in the Tauri shell.
            break
          }
          default: {
            console.warn("unhandled deep link", raw)
            toast.message("Deep link", { description: raw })
          }
        }
      }
    }

    const subscribe = async () => {
      // Tray actions
      // Same semantics as the menu's `newChatAction`, inlined rather than
      // imported: `lib/desktop/menu-actions` pulls in the whole plugin-API
      // graph, which this hook must not drag into its module load.
      // Main-window only — Rust broadcasts `tray://*` to EVERY window, and the
      // pet overlay / popup / island load this same root layout. Creating a
      // session is not idempotent, so an unguarded handler would create one
      // conversation per open window.
      const trayNewChat = await onTauriEvent(TAURI_EVENTS.trayNewChat, () => {
        if (!isMainAppWindow()) return
        useUIStore.getState().setSelectedGuild({ kind: "dm" })
        void startNewSession()
      })
      const traySettings = await onTauriEvent(TAURI_EVENTS.traySettings, () => {
        useUIStore.getState().requestOpenSettings()
      })
      const trayOpenLogs = await onTauriEvent(TAURI_EVENTS.trayOpenLogs, () => {
        navigateToLogs()
      })

      // Menu items — `menu://<id>` for any item not handled natively in Rust.
      const unlistenMenuOpenLogs = await listen<null>(TAURI_EVENTS.menuOpenLogs, () =>
        navigateToLogs()
      )
      // NOTE: `menu://open-workspace` and `menu://new-chat` are intentionally
      // NOT handled here. Both are owned solely by `use-menu-event-router` →
      // `openWorkspaceAction` / `newChatAction`. Subscribing here too would fire
      // two folder pickers — or create two sessions — for one menu click.
      const unlistenDocs = await listen<null>("menu://documentation", async () => {
        const { openExternal } = await import("@/lib/tauri/opener")
        await openExternal("https://v2.tauri.app")
      })

      // CLI args (first launch + second-instance forwarding)
      const cliMatches = await onTauriEvent<unknown>(TAURI_EVENTS.cliMatches, (payload) => {
        console.info("cli://matches", payload)
      })
      const cliSecondInstance = await onTauriEvent<{
        args: string[]
        cwd: string
      }>(TAURI_EVENTS.cliSecondInstance, (payload) => {
        toast.message("Cognia is already running", {
          description: payload?.args?.join(" ") || payload?.cwd || "Window focused",
        })
      })

      // Deep-link URLs received while running
      const deepLink = await onTauriEvent<string[]>(TAURI_EVENTS.deepLink, (urls) => {
        if (Array.isArray(urls)) handleDeepLinks(urls)
        else handleDeepLinks([String(urls)])
      })
      const backgroundJobExited = await onTauriEvent<Record<string, unknown>>(
        TAURI_EVENTS.backgroundJobExited,
        (payload) => {
          void relaySchedulerEvent("job:exited", payload).catch((error) =>
            console.warn("job:exited scheduler event failed", error)
          )
        }
      )
      const backgroundMonitorFired = await onTauriEvent<Record<string, unknown>>(
        TAURI_EVENTS.backgroundMonitorFired,
        (payload) => {
          void relaySchedulerEvent("monitor:fired", payload).catch((error) =>
            console.warn("monitor:fired scheduler event failed", error)
          )
        }
      )

      // Unified tray-click event — the source-of-truth dispatch channel for
      // both built-in actions (slash + plugin commands) and items pinned by
      // the user. Native actions (show / new-chat / settings / open-logs /
      // automation-kill) ALSO fire their legacy events above, so this is
      // additive — `dispatchTrayClick` no-ops for the `kind: "native"` case.
      const trayItemClicked = await listen<{ id: string; payload?: TrayActionPayload }>(
        "tray://item-clicked",
        (event) => {
          void dispatchTrayClick(event.payload?.payload)
        }
      )

      // Unified shortcut event — routed by `ShortcutRegistry::dispatch` in
      // Rust. Built-in `tray.*` ids are no-ops here (Rust ran the action),
      // renderer-bound ids hit `executeCommand`.
      const shortcutTriggered = await listen<{ id: string }>("shortcut://triggered", (event) => {
        if (event.payload?.id) void dispatchShortcut(event.payload.id)
      })

      // Tray About / diagnostics actions. Rust re-emits these from
      // `apply_native`; the real work (OS opener, clipboard, autostart
      // plugin) runs renderer-side via `lib/tray/tray-actions.ts`.
      const trayOpenDataFolder = await listen<null>("tray://open-data-folder", () => {
        void openDataFolder().catch((err) => console.warn("tray open-data-folder failed", err))
      })
      const trayCopyDiagnostics = await listen<null>("tray://copy-diagnostics", () => {
        void copyDiagnostics()
          .then(() => toast.success("Diagnostics copied to clipboard"))
          .catch((err) => console.warn("tray copy-diagnostics failed", err))
      })
      const trayOpenDocs = await listen<null>("tray://open-docs", () => {
        void openDocs().catch((err) => console.warn("tray open-docs failed", err))
      })
      const trayReportIssue = await listen<null>("tray://report-issue", () => {
        void reportIssue().catch((err) => console.warn("tray report-issue failed", err))
      })
      const trayCheckUpdates = await listen<null>("tray://check-updates", () => {
        void checkUpdates()
          .then((outcome) => {
            switch (outcome.kind) {
              case "available":
                toast.success(
                  tRef.current("updates.updateAvailableToast", { version: outcome.version })
                )
                // Hand off to Settings → About, where the download + relaunch lives.
                useUIStore.getState().requestOpenSettings("about")
                break
              case "upToDate":
                toast.success(tRef.current("updates.alreadyLatest"))
                break
              case "error":
                console.warn("tray check-updates failed", outcome.message)
                break
            }
          })
          .catch((err) => console.warn("tray check-updates failed", err))
      })
      const trayToggleAutostart = await listen<null>("tray://toggle-autostart", () => {
        void toggleAutostartAction()
          .then((on) => toast.success(on ? "Launch at login enabled" : "Launch at login disabled"))
          .catch((err) => console.warn("tray toggle-autostart failed", err))
      })

      if (cancelled) {
        safeUnlisten(trayNewChat)
        safeUnlisten(traySettings)
        safeUnlisten(trayOpenLogs)
        safeUnlisten(unlistenMenuOpenLogs)
        safeUnlisten(unlistenDocs)
        safeUnlisten(cliMatches)
        safeUnlisten(cliSecondInstance)
        safeUnlisten(deepLink)
        safeUnlisten(backgroundJobExited)
        safeUnlisten(backgroundMonitorFired)
        safeUnlisten(trayItemClicked)
        safeUnlisten(shortcutTriggered)
        safeUnlisten(trayOpenDataFolder)
        safeUnlisten(trayCopyDiagnostics)
        safeUnlisten(trayOpenDocs)
        safeUnlisten(trayReportIssue)
        safeUnlisten(trayCheckUpdates)
        safeUnlisten(trayToggleAutostart)
        return
      }

      unsubscribers.push(
        trayNewChat,
        traySettings,
        trayOpenLogs,
        unlistenMenuOpenLogs,
        unlistenDocs,
        cliMatches,
        cliSecondInstance,
        deepLink,
        backgroundJobExited,
        backgroundMonitorFired,
        trayItemClicked,
        shortcutTriggered,
        trayOpenDataFolder,
        trayCopyDiagnostics,
        trayOpenDocs,
        trayReportIssue,
        trayCheckUpdates,
        trayToggleAutostart
      )
    }

    void subscribe()

    return () => {
      cancelled = true
      for (const fn of unsubscribers) safeUnlisten(fn)
    }
  }, [router])
}
