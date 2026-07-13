"use client"

import { useEffect } from "react"

import { isTauri } from "@/lib/tauri"
import { loggers } from "@cognia/logging"

const log = loggers.ui

/**
 * Reveals the Tauri main window once the renderer has painted its first frame.
 *
 * The window is created hidden (`visible:false` in `tauri.conf.json`) so the
 * user never sees the white/blank WebView flash that precedes React's first
 * paint and `next-themes` applying the `.dark` class. On mount we wait two
 * animation frames — rAF #1 schedules after layout, rAF #2 runs after the
 * browser has committed a paint — then call `getCurrentWindow().show()` so the
 * window appears already displaying real, themed content.
 *
 * A Rust-side grace timer (`lib.rs` setup) force-shows the window if this never
 * runs, so a renderer crash can't leave an alive-but-invisible process.
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
          const { getCurrentWindow } = await import("@tauri-apps/api/window")
          if (cancelled) return
          const win = getCurrentWindow()
          await win.show()
          await win.setFocus()
        } catch (error) {
          log.warn("window-show: failed to reveal main window", {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })()
    }

    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(reveal)
    })

    return () => {
      cancelled = true
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [])

  return null
}

export default WindowShowInitializer
