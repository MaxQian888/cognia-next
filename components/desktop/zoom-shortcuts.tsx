"use client"

import { applyZoom, clampZoom, DEFAULT_ZOOM, ZOOM_STEP } from "@/lib/tauri/webview-zoom"
import { loggers } from "@cognia/logging"
import { useSettingsStore } from "@/stores/settings"
import { useEffect, useRef } from "react"
import { useAppShortcut } from "@/hooks/shortcuts/use-app-shortcut"

const log = loggers.ui

/**
 * Registers the rebindable VS Code-style webview-zoom shortcuts:
 *   • zoom.in    Ctrl/Cmd + =   (also Shift +, folded to `=` by parseKeyEvent)
 *   • zoom.out   Ctrl/Cmd + -   (also Shift _)
 *   • zoom.reset Ctrl/Cmd + 0
 *
 * The window listener, `platform.tauri` gate, and plugin notify are owned by the
 * single dispatcher (descriptors carry `when: "platform.tauri"`). Zoom fires even
 * while a field is focused (`allowInEditable`), matching the pre-migration
 * behavior. The debounced persist + `zoomRef` accumulation stay here — only the
 * key-matching moved to the registry.
 */
export function ZoomShortcuts() {
  const settingsLoaded = useSettingsStore((s) => s.loaded)
  const persistedZoom = useSettingsStore((s) => s.settings?.webviewZoom)
  const save = useSettingsStore((s) => s.save)

  // Hold the live zoom in a ref so successive presses don't all read the same
  // stale store snapshot — settings is an async write, so a fast double-tap
  // would otherwise compute from the same baseline twice.
  const zoomRef = useRef(DEFAULT_ZOOM)
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (settingsLoaded) {
      zoomRef.current = clampZoom(persistedZoom ?? DEFAULT_ZOOM)
    }
  }, [settingsLoaded, persistedZoom])

  function schedulePersist(level: number) {
    if (persistTimer.current) clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(() => {
      void save({ webviewZoom: level }).catch((err) =>
        log.warn("zoom persist failed", {
          error: err instanceof Error ? err.message : String(err),
        })
      )
    }, 400)
  }

  async function step(delta: number) {
    const next = await applyZoom(zoomRef.current + delta)
    zoomRef.current = next
    schedulePersist(next)
  }

  async function reset() {
    const next = await applyZoom(DEFAULT_ZOOM)
    zoomRef.current = next
    schedulePersist(next)
  }

  const options = { preventDefault: true, allowInEditable: true }
  useAppShortcut("zoom.in", () => void step(ZOOM_STEP), options)
  useAppShortcut("zoom.out", () => void step(-ZOOM_STEP), options)
  useAppShortcut("zoom.reset", () => void reset(), options)

  useEffect(
    () => () => {
      if (persistTimer.current) clearTimeout(persistTimer.current)
    },
    []
  )

  return null
}

export default ZoomShortcuts
