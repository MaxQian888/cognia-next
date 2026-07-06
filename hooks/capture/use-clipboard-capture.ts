"use client"

/**
 * Clipboard watcher for content capture. Polls the clipboard on the configured
 * interval; on new text it builds a candidate, tags the source app, and either
 * shows the confirm bubble (`confirm` mode) or auto-saves (`silent` mode).
 * Disabled entirely in `manual` / `privacyMode` / when the feature is off.
 */

import { useEffect, useRef } from "react"
import { useSettingsStore } from "@/stores/settings"
import { useCaptureStore } from "@/stores/capture/capture-store"
import { buildTextCandidate } from "@/lib/capture/detect"
import { persistCapture, detectSourceApp } from "@/lib/capture/capture-manager"
import { buildEnrichDeps } from "@/lib/capture/enrich"
import { DEFAULT_CAPTURE_SETTINGS, type CaptureSettings } from "@/types/capture"

async function readClipboardText(): Promise<string | null> {
  try {
    const { isTauri } = await import("@/lib/native/utils")
    if (isTauri()) {
      const mod = await import("@tauri-apps/plugin-clipboard-manager")
      return (await mod.readText()) ?? null
    }
  } catch {
    // Fall through to the web clipboard API.
  }
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
      return await navigator.clipboard.readText()
    }
  } catch {
    // Clipboard permission denied / unavailable.
  }
  return null
}

export function useClipboardCapture(): void {
  const settings = useSettingsStore((s) => s.settings?.capture)
  const lastRef = useRef<string | null>(null)

  useEffect(() => {
    const cfg: CaptureSettings = settings ?? DEFAULT_CAPTURE_SETTINGS
    if (!cfg.enabled || cfg.privacyMode || cfg.mode === "manual" || cfg.pollIntervalMs <= 0) {
      return
    }
    let cancelled = false

    const tick = async () => {
      const text = await readClipboardText()
      if (cancelled || !text) return
      const candidate = await buildTextCandidate(text)
      if (cancelled || !candidate) return
      if (candidate.fingerprint === lastRef.current) return
      lastRef.current = candidate.fingerprint
      candidate.sourceApp = await detectSourceApp()
      if (cancelled) return
      if (cfg.mode === "silent") {
        try {
          await persistCapture(candidate, { deps: buildEnrichDeps() })
        } catch {
          // Best-effort in silent mode.
        }
      } else {
        useCaptureStore.getState().request(candidate)
      }
    }

    const interval = setInterval(() => void tick(), cfg.pollIntervalMs)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [settings])
}
