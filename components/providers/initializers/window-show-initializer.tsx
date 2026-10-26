"use client"

import { useEffect } from "react"

import { isTauri } from "@/lib/tauri"
import { refreshHostMode } from "@/lib/tauri/host-mode"
import { isMacPlatform } from "@/lib/tauri/os"
import { loggers } from "@cognia/logging"

const log = loggers.ui

/**
 * Reveals the Tauri main window once the renderer has painted its first frame.
 *
 * The window is created hidden (`visible:false` in `tauri.conf.json`) so the
 * user never sees the white/blank WebView flash that precedes React's first
 * paint and `next-themes` applying the `.dark` class. On Windows we wait two
 * animation frames — rAF #1 schedules after layout, rAF #2 runs after the
 * browser has committed a paint — then call `getCurrentWindow().show()` so the
 * window appears already displaying real, themed content. macOS uses an
 * effect microtask because a hidden WKWebView may not schedule animation frames.
 *
 * A Rust-side grace timer (`lib.rs` setup) force-shows the window if this never
 * runs, so a renderer crash can't leave an alive-but-invisible process.
 *
 * A login launch in always-on host mode (ADR-0224 A3) stays hidden: Rust
 * reports it as `bootHidden` and has already disarmed the grace timer. The
 * user brings the window back from the tray or the Dock. A failed read shows
 * the window, since a hidden app nobody asked for is the worse mistake.
 *
 * No-op (renders nothing) outside the Tauri desktop shell.
 */
export function WindowShowInitializer() {
  useEffect(() => {
    if (!isTauri()) return

    let cancelled = false
    let raf1 = 0
    let raf2 = 0

    const reveal = () => {
      void (async () => {
        try {
          const hostMode = await refreshHostMode().catch(() => null)
          if (cancelled || hostMode?.bootHidden) return
          const { getCurrentWindow } = await import("@tauri-apps/api/window")
          if (cancelled) return
          const win = getCurrentWindow()
          await win.show()
          try {
            const { invoke } = await import("@tauri-apps/api/core")
            await invoke("webview_acknowledge_boot_reveal")
          } catch (error) {
            log.warn("window-show: failed to acknowledge boot reveal", {
              error: error instanceof Error ? error.message : String(error),
            })
          }
          await win.setFocus()
        } catch (error) {
          log.warn("window-show: failed to reveal main window", {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })()
    }

    // Hidden WKWebViews may not receive animation frames. Waiting for one
    // before showing the window would leave the native grace timer in charge.
    if (isMacPlatform()) {
      queueMicrotask(reveal)
    } else {
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(reveal)
      })
    }

    return () => {
      cancelled = true
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [])

  return null
}

export default WindowShowInitializer
