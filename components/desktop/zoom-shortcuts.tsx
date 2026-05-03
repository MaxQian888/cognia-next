"use client"

import { applyZoom, clampZoom, DEFAULT_ZOOM, ZOOM_STEP } from "@/lib/tauri/webview-zoom"
import { loggers } from "@/lib/logger"
import { useSettingsStore } from "@/stores/settings"
import { useEffect, useRef } from "react"

const log = loggers.ui

/**
 * Headless component that wires VSCode-style zoom hotkeys to the persisted
 * `webviewZoom` setting:
 *   • Ctrl/Cmd + =  zoom in
 *   • Ctrl/Cmd + -  zoom out
 *   • Ctrl/Cmd + 0  reset
 * Persistence is debounced so a flurry of presses only writes once.
 */
export function ZoomShortcuts() {
  const settingsLoaded = useSettingsStore((s) => s.loaded)
  const persistedZoom = useSettingsStore((s) => s.settings?.webviewZoom)
  const save = useSettingsStore((s) => s.save)

  // Hold the live zoom in a ref so successive presses don't all read the
  // same stale store snapshot — `setState`-style fan-out from a key event
  // is nice in theory but settings is an async write, which means a fast
  // double-tap would otherwise compute from the same baseline twice.
  const zoomRef = useRef(DEFAULT_ZOOM)
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (settingsLoaded) {
      zoomRef.current = clampZoom(persistedZoom ?? DEFAULT_ZOOM)
    }
  }, [settingsLoaded, persistedZoom])

  useEffect(() => {
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

    function onKeyDown(event: KeyboardEvent) {
      const mod = event.ctrlKey || event.metaKey
      if (!mod) return
      // VSCode treats both `=` and `+` as zoom in (the `+` sits on the same
      // physical key on US/JP layouts).
      if (event.key === "=" || event.key === "+") {
        event.preventDefault()
        void step(ZOOM_STEP)
        return
      }
      if (event.key === "-" || event.key === "_") {
        event.preventDefault()
        void step(-ZOOM_STEP)
        return
      }
      if (event.key === "0") {
        event.preventDefault()
        void reset()
      }
    }

    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      if (persistTimer.current) clearTimeout(persistTimer.current)
    }
  }, [save])

  return null
}
