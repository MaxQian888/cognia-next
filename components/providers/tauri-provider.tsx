"use client"

import { useEffect } from "react"
import { useTheme } from "next-themes"
import { useLocale } from "next-intl"
import { toast } from "sonner"
import { useSessionNotifications } from "@/hooks/chat/use-session-notifications"
import { useTauriEvents } from "@/hooks/system"
import { getLaunchCli } from "@/lib/tauri/cli"
import { getLaunchDeepLink } from "@/lib/tauri/deep-link"
import { getCloseBehavior, pushCloseBehaviorToRust } from "@/lib/tauri/close-behavior"
import { setWindowBackgroundColor } from "@/lib/tauri/shell-window"
import { getShellColors } from "@/lib/appearance/shell-sync"
import { isTauri } from "@/lib/tauri"
import { useChatStore } from "@/stores/chat"
import { startNewSession } from "@/lib/chat/start-session"
import { useSettingsStore } from "@/stores/settings"
import { useUIStore } from "@/stores/ui"
import { useTrayStore } from "@/lib/tray/store"
import { useSyncTrayToRust } from "@/lib/tray/sync"
import { useSyncShortcutsToRust } from "@/lib/shortcuts/sync"
import { rasterizeAndRegisterTrayIcons } from "@/lib/tray/icon-builder"
import { pushCrashContext } from "@/lib/native/crash-context"
import { installNotificationBridges } from "@/lib/notifications/install"
import { isMainAppWindow } from "@/lib/pet/window-role"

/**
 * Single mount point for desktop-runtime concerns:
 *   - Subscribes to tray/menu/cli/deep-link events from the Rust side.
 *   - Leaves notification permission to the contextual Settings CTA; boot only
 *     checks permission lazily when a native notification is requested.
 *   - On first launch, applies CLI args and any cold-start deep-link URL.
 *
 * Renders nothing; intended to wrap the app under the existing providers in
 * `app/layout.tsx`.
 */
export function TauriProvider({ children }: { children: React.ReactNode }) {
  useTauriEvents()
  useSessionNotifications()
  // Wire the runtime-independent Notification Center inbound bridges
  // (plugin / connector) once. Capacitor push is installed after native
  // plugin registration by CompanionBootProvider.
  useEffect(() => {
    installNotificationBridges()
  }, [])
  // System-tray + global-shortcut sync hooks. Each mounts a single
  // subscription and pushes via the debounced IPC bridge once the user's
  // persisted layout / bindings have hydrated.
  useSyncTrayToRust()
  useSyncShortcutsToRust()

  const { resolvedTheme } = useTheme()
  const locale = useLocale()
  const appearanceColorTheme = useSettingsStore((s) => s.colorTheme)
  const appearanceActiveCustomThemeId = useSettingsStore((s) => s.activeCustomThemeId)
  const appearanceCustomThemes = useSettingsStore((s) => s.customThemes)
  // High contrast replaces the whole palette, so without this the window
  // background stayed on the normal palette while the app repainted.
  const appearanceA11y = useSettingsStore((s) => s.settings?.a11y)

  // Feed the crash-report subsystem a redacted config snapshot so a later Rust
  // panic / native crash report reflects the current app state. Change-driven
  // (theme / locale) — these are the meaningful signals and don't churn. No-op
  // on web; `pushCrashContext` short-circuits when not under Tauri.
  useEffect(() => {
    if (!isTauri() || !isMainAppWindow()) return
    void pushCrashContext({
      runtime: "tauri",
      colorTheme: appearanceColorTheme,
      activeCustomThemeId: appearanceActiveCustomThemeId,
      resolvedTheme,
      locale,
    })
  }, [appearanceColorTheme, appearanceActiveCustomThemeId, resolvedTheme, locale])

  // Push the appearance background colour into the native Tauri window so
  // the custom titlebar (decorations=false on Windows) repaints in lockstep
  // with the in-app theme. No-op on web; `setWindowBackgroundColor`
  // short-circuits when not running under Tauri.
  useEffect(() => {
    if (!isTauri() || !isMainAppWindow()) return
    if (!resolvedTheme) return
    const shellColors = getShellColors(
      {
        colorTheme: appearanceColorTheme,
        activeCustomThemeId: appearanceActiveCustomThemeId,
        customThemes: appearanceCustomThemes,
        a11y: appearanceA11y,
      },
      resolvedTheme
    )
    void setWindowBackgroundColor(shellColors.backgroundHex)
  }, [
    resolvedTheme,
    appearanceColorTheme,
    appearanceActiveCustomThemeId,
    appearanceCustomThemes,
    appearanceA11y,
  ])

  useEffect(() => {
    // The transparent pet overlay/popup windows load this same root layout but
    // are least-privilege (see `src-tauri/capabilities/pet.json`) — running the
    // main-window boot sequence there only logs denied-capability warnings for
    // notification / tray-store / CLI / deep-link. Skip it in pet windows; they
    // start their own presentation-only view.
    if (!isTauri() || !isMainAppWindow()) return
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
      // Push the saved close behavior into Rust so the window's
      // close-requested handler reflects user intent from the very first
      // close event, not just after they visit Settings → Desktop.
      try {
        await pushCloseBehaviorToRust(await getCloseBehavior())
      } catch (err) {
        console.warn("hydrate close-behavior failed", err)
      }

      // CLI args from this launch — `cognia <path>` opens that workspace,
      // `--new-chat` starts a fresh conversation.
      try {
        const { workspacePath, newChat } = await getLaunchCli()
        if (workspacePath) {
          await useSettingsStore.getState().save({
            defaultWorkingDir: workspacePath,
          })
          toast.success("Workspace from CLI", { description: workspacePath })
        }
        if (newChat) {
          useUIStore.getState().setSelectedGuild({ kind: "dm" })
          await startNewSession()
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
