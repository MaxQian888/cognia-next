"use client"

/**
 * Persistence wrapper around `<OcrSection />`.
 *
 * Reads `UserOcrSettings` from the Dexie `appSettings` blob via
 * `useLiveQuery`, passes it down, and persists `onChange` back via
 * `saveSettings`. Mirrors the merge pattern used for `background` and
 * `networkProxy` settings.
 *
 * Cache helpers (`onClearCache` / `onClearProviderCache`) are wired to the
 * existing `lib/db/ocr-results.ts` helpers so the sidebar/Auto-Router buttons
 * actually clear the Dexie table — they were no-ops before.
 *
 * Credentials remain in-session memory until an `ocr_keyring_*` Tauri
 * surface lands (out of scope for this redesign — see ADR-0024).
 */

import * as React from "react"
import { useCallback, useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"
import { OcrSection } from "./ocr-section"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { clearOcrCache, clearOcrCacheForProvider } from "@/lib/db/ocr-results"
import { DEFAULT_OCR_SETTINGS, type UserOcrSettings } from "@/lib/ocr/types"

export function OcrSectionPersisted(): React.ReactElement {
  const settings = useLiveQuery(async () => (await getSettings()).ocrSettings, [])

  const effectiveSettings: UserOcrSettings = useMemo(
    () => settings ?? DEFAULT_OCR_SETTINGS,
    [settings]
  )

  const handleChange = useCallback((next: UserOcrSettings) => {
    void saveSettings({ ocrSettings: next }).catch((err) => {
      toast.error(err instanceof Error ? err.message : String(err))
    })
  }, [])

  const handleClearCache = useCallback(async () => {
    try {
      const removed = await clearOcrCache()
      toast.success(`Cleared ${removed} cached OCR result${removed === 1 ? "" : "s"}.`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const handleClearProviderCache = useCallback(async (providerId: string) => {
    try {
      const removed = await clearOcrCacheForProvider(providerId)
      toast.success(
        `Cleared ${removed} cached entr${removed === 1 ? "y" : "ies"} for ${providerId}.`
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }, [])

  return (
    <OcrSection
      settings={effectiveSettings}
      onChange={handleChange}
      onClearCache={handleClearCache}
      onClearProviderCache={handleClearProviderCache}
    />
  )
}
