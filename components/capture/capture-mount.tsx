"use client"

/**
 * Always-mounted capture host: runs the clipboard watcher and renders the
 * confirm bubble. Mounted once in the app layout alongside the pet mount.
 */

import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_CAPTURE_SETTINGS } from "@/types/capture"
import { useClipboardCapture } from "@/hooks/capture/use-clipboard-capture"
import { CaptureBubble } from "./capture-bubble"

export function CaptureMount() {
  const timeoutSec =
    useSettingsStore((s) => s.settings?.capture?.confirmTimeoutSec) ??
    DEFAULT_CAPTURE_SETTINGS.confirmTimeoutSec
  useClipboardCapture()
  return <CaptureBubble timeoutSec={timeoutSec} />
}
