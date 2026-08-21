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
import { loggers } from "@cognia/logging"

const log = loggers.shell.child("window-controls")

type WindowApi = {
  minimize: () => Promise<void>
  toggleMaximize: () => Promise<void>
  close: () => Promise<void>
  isMaximized: () => Promise<boolean>
  onResized: (cb: () => void) => Promise<() => void>
}

async function getWin(): Promise<WindowApi> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window")
  return getCurrentWindow() as unknown as WindowApi
}

/**
 * - `"none"` — no window to control (web shell). Draw nothing, reserve nothing.
 * - `"traffic-lights"` — macOS draws the buttons itself, over the content.
 *   Reserve ~80px on the leading edge or your own content lands under them.
 * - `"buttons"` — Windows/Linux under Tauri. `WindowControls` renders here.
 */
export type WindowChromeMode = "none" | "traffic-lights" | "buttons"

export function useWindowChromeMode(): WindowChromeMode {
  // Starts at `"none"` so the static-export HTML and the first hydration pass
  // agree: `isTauri()` and `navigator.platform` are both browser-only reads.
  const [mode, setMode] = useState<WindowChromeMode>("none")

  useEffect(() => {
    if (!isTauri() || typeof navigator === "undefined") return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMode(navigator.platform.toLowerCase().includes("mac") ? "traffic-lights" : "buttons")
  }, [])

  return mode
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
    void (async () => {
      try {
        const win = await getWin()
        setMaximized(await win.isMaximized())
        unlisten = await win.onResized(async () => {
          setMaximized(await win.isMaximized())
        })
      } catch (err) {
        log.warn("window setup failed", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })()
    return () => unlisten?.()
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
