"use client"

import { useCallback, useSyncExternalStore } from "react"

import {
  isSupportDiagnosticsEnabled,
  setSupportDiagnosticsEnabled,
  subscribeSupportDiagnosticsConsent,
} from "@/lib/support-agent/context"
import { trackEvent } from "@/lib/telemetry/events/track-event"

export type SupportConsentSurface = "chat" | "settings"

/**
 * The Support Agent's local diagnostics kill switch as React state.
 *
 * Backed by `localStorage` (deliberately per-device — it is a *local* kill
 * switch, not a synced preference) and shared through `useSyncExternalStore`, so the
 * chat strip's popover and the Settings → Characters row flip together instead
 * of each holding a stale `useState` copy.
 */
export function useSupportDiagnosticsConsent(surface: SupportConsentSurface) {
  const enabled = useSyncExternalStore(
    subscribeSupportDiagnosticsConsent,
    () => isSupportDiagnosticsEnabled(),
    () => false
  )
  const setEnabled = useCallback(
    (next: boolean) => {
      setSupportDiagnosticsEnabled(next)
      void trackEvent("support.diagnostics.consent.changed", { enabled: next, surface })
    },
    [surface]
  )
  return { enabled, setEnabled }
}
