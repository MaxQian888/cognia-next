"use client"

import { useEffect } from "react"
import { invoke } from "@tauri-apps/api/core"
import { useTheme } from "next-themes"
import { toast } from "sonner"
import { useSessionNotifications } from "@/hooks/chat"
import { useTauriEvents } from "@/hooks/system"
import { ensureNotificationPermission } from "@/lib/tauri/notification"
import { getLaunchCli } from "@/lib/tauri/cli"
import { getLaunchDeepLink } from "@/lib/tauri/deep-link"
import { getPref } from "@/lib/tauri/store"
import { setWindowBackgroundColor } from "@/lib/tauri/shell-window"
import { getShellColors } from "@/lib/appearance/shell-sync"
import { isTauri } from "@/lib/tauri"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { useUIStore } from "@/stores/ui"
import { useTrayStore } from "@/lib/tray/store"
import { useSyncTrayToRust } from "@/lib/tray/sync"
import { useSyncShortcutsToRust } from "@/lib/shortcuts/sync"
import { rasterizeAndRegisterTrayIcons } from "@/lib/tray/icon-builder"

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
  // System-tray + global-shortcut sync hooks. Each mounts a single
  // subscription and pushes via the debounced IPC bridge once the user's
  // persisted layout / bindings have hydrated.
  useSyncTrayToRust()
  useSyncShortcutsToRust()

  const { resolvedTheme } = useTheme()
  const appearanceColorTheme = useSettingsStore((s) => s.colorTheme)
  const appearanceActiveCustomThemeId = useSettingsStore((s) => s.activeCustomThemeId)
  const appearanceCustomThemes = useSettingsStore((s) => s.customThemes)

  // Push the appearance background colour into the native Tauri window so
  // the custom titlebar (decorations=false on Windows) repaints in lockstep
  // with the in-app theme. No-op on web; `setWindowBackgroundColor`
  // short-circuits when not running under Tauri.
  useEffect(() => {
    if (!isTauri()) return
    if (!resolvedTheme) return
    const shellColors = getShellColors(
      {
        colorTheme: appearanceColorTheme,
        activeCustomThemeId: appearanceActiveCustomThemeId,
        customThemes: appearanceCustomThemes,
      },
      resolvedTheme
    )
    void setWindowBackgroundColor(shellColors.backgroundHex)
  }, [resolvedTheme, appearanceColorTheme, appearanceActiveCustomThemeId, appearanceCustomThemes])

  useEffect(() => {
    if (!isTauri()) return
    void ensureNotificationPermission()

    // Kick off tray-store hydration as soon as the provider mounts. The
    // sync hook above only flushes once `hydrated === true`, so the user
    // never sees the default-flash overwrite their customised layout.
    void useTrayStore.getState().hydrate()

    // Rasterize and register the four Lucide-based tray icons. Each PNG
    // is built once via an offscreen canvas, pushed to Rust as raw bytes,
    // and cached there keyed by state — subsequent state swaps reuse the
    // cached image without crossing the IPC boundary.
    void rasterizeAndRegisterTrayIcons()

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
