"use client"

/**
 * The frameless window's minimise / maximise / close cluster, plus the rule for
 * which window chrome a platform actually needs.
 *
 * **Why this exists separately from `TitleBar`.** The title bar is not the only
 * surface that can own the whole window: the first-run takeover (ADR-0122)
 * suppresses the desktop chrome entirely, and without a cluster of its own a
 * Windows/Linux user would have no way to minimise or close the app for the
 * length of the flow. `decorations: false` in `tauri.conf.json` means the OS
 * draws nothing — every button here is the only one there is.
 *
 * **Three modes, not a boolean.** macOS keeps its native traffic lights
 * (`titleBarStyle: "Overlay"`, positioned at 16×14), so the correct behaviour
 * there is to draw no buttons *and reserve room on the left* — a surface that
 * only asks "do I render buttons?" paints its own content under them. The web
 * shell has no window to control at all. `useWindowChromeMode()` is what any
 * full-window surface asks instead of re-deriving the platform rules.
 *
 * `TitleBar` still carries its own inline copy of these three buttons: its
 * handlers are shared with the File and system menus and log under that bar's
 * scope, so folding it onto this component is a change to that file rather
 * than a side effect of adding a second consumer.
 */

import { MaximizeIcon, MinimizeIcon, MinusIcon, XIcon } from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { isTauri } from "@/lib/tauri"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"
import { loggers } from "@cognia/logging"

const log = loggers.shell.child("window-controls")

type WindowApi = {
  minimize: () => Promise<void>
  toggleMaximize: () => Promise<void>
  close: () => Promise<void>
  isMaximized: () => Promise<boolean>
  isFullscreen?: () => Promise<boolean>
  onResized: (cb: () => void) => Promise<() => void>
}

async function getWin(): Promise<WindowApi> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window")
  return getCurrentWindow() as unknown as WindowApi
}

/**
 * - `"none"` — nothing to draw, nothing to reserve: the web shell, or macOS in
 *   native fullscreen, where the traffic lights are hidden (they only slide in
 *   with the menu bar while the pointer is at the top edge, over the content).
 * - `"traffic-lights"` — macOS draws the buttons itself, over the content.
 *   Reserve ~80px on the leading edge or your own content lands under them.
 * - `"buttons"` — Windows/Linux under Tauri. `WindowControls` renders here.
 */
export type WindowChromeMode = "none" | "traffic-lights" | "buttons"

/**
 * Whether the current window is in native fullscreen, tracked live.
 *
 * Tauri has no dedicated fullscreen event, but entering or leaving it always
 * resizes the window, so every `onResized` re-reads `isFullscreen()`. Only
 * subscribes while `enabled` — the one consumer that needs it is the macOS
 * traffic-light reserve, which a fullscreen window must drop or it leaves an
 * 88px blank where the (now hidden) buttons used to sit.
 */
export function useNativeFullscreen(enabled: boolean): boolean {
  const [fullscreen, setFullscreen] = useState(false)

  useEffect(() => {
    if (!enabled) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFullscreen(false)
      return
    }
    let unlisten: (() => void) | undefined
    let cancelled = false
    void (async () => {
      try {
        const win = await getWin()
        if (typeof win.isFullscreen !== "function") return
        const read = win.isFullscreen.bind(win)
        const initial = await read()
        if (cancelled) return
        setFullscreen(initial)
        const dispose = await win.onResized(async () => {
          try {
            const next = await read()
            if (!cancelled) setFullscreen(next)
          } catch (err) {
            log.warn("fullscreen read failed", {
              error: err instanceof Error ? err.message : String(err),
            })
          }
        })
        // Unmounted while the registration was in flight: release it now.
        if (cancelled) {
          safeUnlisten(dispose)
          return
        }
        unlisten = dispose
      } catch (err) {
        log.warn("fullscreen tracking setup failed", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })()
    return () => {
      cancelled = true
      safeUnlisten(unlisten)
    }
  }, [enabled])

  return fullscreen
}

export function useWindowChromeMode(): WindowChromeMode {
  // Starts at `"none"` so the static-export HTML and the first hydration pass
  // agree: `isTauri()` and `navigator.platform` are both browser-only reads.
  const [mode, setMode] = useState<WindowChromeMode>("none")

  useEffect(() => {
    if (!isTauri() || typeof navigator === "undefined") return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMode(navigator.platform.toLowerCase().includes("mac") ? "traffic-lights" : "buttons")
  }, [])

  const fullscreen = useNativeFullscreen(mode === "traffic-lights")
  return mode === "traffic-lights" && fullscreen ? "none" : mode
}

/**
 * Renders nothing unless this platform expects the app to draw its own window
 * buttons, so callers can mount it unconditionally.
 */
export function WindowControls({ className }: { className?: string }) {
  const t = useTranslations("desktop.titleBar")
  const mode = useWindowChromeMode()
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (mode !== "buttons") return
    let unlisten: (() => void) | undefined
    let cancelled = false
    void (async () => {
      try {
        const win = await getWin()
        const initiallyMaximized = await win.isMaximized()
        if (cancelled) return
        setMaximized(initiallyMaximized)
        const dispose = await win.onResized(async () => {
          const next = await win.isMaximized()
          if (!cancelled) setMaximized(next)
        })
        // Unmounted while the registration was in flight: release it now.
        if (cancelled) {
          safeUnlisten(dispose)
          return
        }
        unlisten = dispose
      } catch (err) {
        log.warn("window setup failed", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })()
    return () => {
      cancelled = true
      safeUnlisten(unlisten)
    }
  }, [mode])

  if (mode !== "buttons") return null

  const run = (action: "minimize" | "toggleMaximize" | "close") => async () => {
    log.info(`window ${action}`)
    try {
      const win = await getWin()
      await win[action]()
    } catch (err) {
      log.error(`window ${action} failed`, err)
    }
  }

  return (
    <div className={cn("flex items-center", className)} data-testid="window-controls">
      <WindowButton onClick={run("minimize")} aria-label={t("minimize")}>
        <MinusIcon className="size-3.5" />
      </WindowButton>
      <WindowButton
        onClick={run("toggleMaximize")}
        aria-label={maximized ? t("restore") : t("maximize")}
      >
        {maximized ? <MinimizeIcon className="size-3.5" /> : <MaximizeIcon className="size-3.5" />}
      </WindowButton>
      <WindowButton
        onClick={run("close")}
        aria-label={t("close")}
        className="hover:bg-destructive hover:text-destructive-foreground"
      >
        <XIcon className="size-3.5" />
      </WindowButton>
    </div>
  )
}

/**
 * Square, full-height, and deliberately not rounded: these sit flush in the
 * window's top corner, where a radius would leave a lit sliver of page showing
 * through the corner of the close button.
 */
function WindowButton({ className, ...props }: React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("h-10 w-10 rounded-none transition-colors", className)}
      {...props}
    />
  )
}
