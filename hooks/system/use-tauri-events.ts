"use client"

import { useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { listen } from "@tauri-apps/api/event"
import { TAURI_EVENTS, onTauriEvent } from "@/lib/tauri"
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

interface ParsedDeepLink {
  kind: "chat" | "settings" | "workspace" | "unknown"
  chatId?: string
  workspacePath?: string
  settingsTab?: string
}

/**
 * Parse a single `cognia://` URL into the action it should drive.
 *
 *   cognia://chat/<id>            → open that session
 *   cognia://settings[?tab=xyz]   → open settings (optionally on a tab)
 *   cognia://workspace?path=…     → create/activate a workspace for that path
 */
function parseDeepLink(raw: string): ParsedDeepLink {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { kind: "unknown" }
  }
  if (url.protocol !== "cognia:") return { kind: "unknown" }

  // For custom schemes, `host` holds the first segment after `://`.
  const head = url.host || url.pathname.replace(/^\/+/, "").split("/")[0] || ""
  if (head === "chat") {
    const id =
      url.pathname.replace(/^\/+/, "").split("/").filter(Boolean)[0] ||
      url.searchParams.get("id") ||
      ""
    return { kind: "chat", chatId: id || undefined }
  }
  if (head === "settings") {
    return { kind: "settings", settingsTab: url.searchParams.get("tab") ?? undefined }
  }
  if (head === "workspace") {
    return { kind: "workspace", workspacePath: url.searchParams.get("path") ?? undefined }
  }
  return { kind: "unknown" }
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
        const action = parseDeepLink(raw)
        switch (action.kind) {
          case "chat": {
            if (action.chatId) {
              useChatStore.getState().setActiveSession(action.chatId)
              useUIStore.getState().setSelectedGuild({ kind: "dm" })
            }
            break
          }
          case "settings": {
            useUIStore.getState().requestOpenSettings(action.settingsTab)
            break
          }
          case "workspace": {
            // Unified flow: create/activate a real workspace Project for the
            // deep-linked path (consistent with the File menu / switcher).
            if (action.workspacePath) openPathAsWorkspace(action.workspacePath)
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
