"use client"

import { useEffect } from "react"
import { invoke } from "@tauri-apps/api/core"
import { toast } from "sonner"
import { useSessionNotifications } from "@/hooks/use-session-notifications"
import { useTauriEvents } from "@/hooks/use-tauri-events"
import { ensureNotificationPermission } from "@/lib/tauri/notification"
import { getLaunchCli } from "@/lib/tauri/cli"
import { getLaunchDeepLink } from "@/lib/tauri/deep-link"
import { getPref } from "@/lib/tauri/store"
import { isTauri } from "@/lib/tauri"
import { useChatStore } from "@/stores/chat-store"
import { useSettingsStore } from "@/stores/settings-store"
import { useUIStore } from "@/stores/ui-store"

const PREF_TRAY_ON_CLOSE = "tray.minimize-on-close"

/**
 * Single mount point for desktop-runtime concerns:
 *   - Subscribes to tray/menu/cli/deep-link events from the Rust side.
 *   - Asks the OS once for notification permission so later `notify()` calls
 *     succeed without ceremony.
 *   - On first launch, applies CLI args and any cold-start deep-link URL.
 *
 * Renders nothing; intended to wrap the app under the existing providers in
 * `app/layout.tsx`.
 */
export function TauriProvider({ children }: { children: React.ReactNode }) {
  useTauriEvents()
  useSessionNotifications()

  useEffect(() => {
    if (!isTauri()) return
    void ensureNotificationPermission()

    void (async () => {
      // Push the saved tray-on-close preference into Rust so the window's
      // close-requested handler reflects user intent from the very first
      // close event, not just after they visit Settings → Desktop.
      try {
        const tray = await getPref<boolean>(PREF_TRAY_ON_CLOSE)
        await invoke("set_tray_on_close", { enabled: Boolean(tray) })
      } catch (err) {
        console.warn("hydrate tray-on-close failed", err)
      }

      // CLI args from this launch — `cognia <path>` opens that workspace,
      // `--new-chat` clears the active session.
      try {
        const { workspacePath, newChat } = await getLaunchCli()
        if (workspacePath) {
          await useSettingsStore.getState().save({
            defaultWorkingDir: workspacePath,
          })
          toast.success("Workspace from CLI", { description: workspacePath })
        }
        if (newChat) {
          useChatStore.getState().clear()
          useUIStore.getState().setSelectedGuild({ kind: "dm" })
        }
      } catch (err) {
        console.warn("getLaunchCli failed", err)
      }

      // Cold-start deep link — `cognia://...` URLs the OS launched us with.
      try {
        const urls = await getLaunchDeepLink()
        if (urls && urls.length > 0) {
          for (const raw of urls) {
            try {
              const url = new URL(raw)
              if (url.protocol !== "cognia:") continue
              const head = url.host || url.pathname.replace(/^\/+/, "").split("/")[0]
              if (head === "chat") {
                const id =
                  url.pathname.replace(/^\/+/, "").split("/").filter(Boolean)[0] ||
                  url.searchParams.get("id") ||
                  ""
                if (id) {
                  useChatStore.getState().setActiveSession(id)
                  useUIStore.getState().setSelectedGuild({ kind: "dm" })
                }
              } else if (head === "settings") {
                useUIStore.getState().requestOpenSettings(url.searchParams.get("tab") ?? undefined)
              }
            } catch {
              // Ignore individual malformed URLs; log once at top level below.
            }
          }
        }
      } catch (err) {
        console.warn("getLaunchDeepLink failed", err)
      }
    })()
  }, [])

  return <>{children}</>
}
