"use client"

/**
 * Persistence wrapper around `<OcrSection />`.
 *
 * Reads `UserOcrSettings` from the Dexie `appSettings` blob via `useLiveQuery`,
 * passes it down, and persists `onChange` back via `saveSettings`. Mirrors the
 * merge pattern used for `background` and `networkProxy` settings.
 *
 * Cache helpers (`onClearCache` / `onClearProviderCache`) are wired to the
 * existing `lib/db/ocr-results.ts` helpers so the sidebar/Auto-Router buttons
 * actually clear the Dexie table.
 *
 * Credentials are now durable: cloud-provider secrets are read from / written
 * to the `"ocr"` keyring namespace via `lib/ocr/credentials`. The Try-It /
 * Compare flows receive a real `ocrDepsFactory` built from `buildOcrDeps()`,
 * so the auto-router, cache, and keyring-backed credentials all run for real.
 */

import * as React from "react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"
import { OcrSection, OCR_PROVIDER_REGISTRY } from "./ocr-section"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { clearOcrCache, clearOcrCacheForProvider } from "@/lib/db/ocr-results"
import { buildOcrDeps } from "@/lib/ocr/deps"
import { getOcrSecret, setOcrSecret } from "@/lib/ocr/credentials"
import { DEFAULT_OCR_SETTINGS, type UserOcrSettings } from "@/types/ocr"

/** Read every stored cloud-provider secret so the form + wizard reflect reality. */
async function loadStoredCredentials(): Promise<Record<string, Record<string, string>>> {
  const out: Record<string, Record<string, string>> = {}
  await Promise.all(
    OCR_PROVIDER_REGISTRY.map(async (provider) => {
      if (provider.credentialKeys.length === 0) return
      const entry: Record<string, string> = {}
      await Promise.all(
        provider.credentialKeys.map(async (key) => {
          const value = await getOcrSecret(provider.id, key).catch(() => null)
          if (value) entry[key] = value
        })
      )
      if (Object.keys(entry).length > 0) out[provider.id] = entry
    })
  )
  return out
}

export function OcrSectionPersisted(): React.ReactElement | null {
  const settings = useLiveQuery(async () => (await getSettings()).ocrSettings, [])
  const [credentials, setCredentials] = useState<Record<string, Record<string, string>> | null>(
    null
  )

  useEffect(() => {
    let cancelled = false
    void loadStoredCredentials()
      .then((loaded) => {
        if (!cancelled) setCredentials(loaded)
      })
      .catch(() => {
        if (!cancelled) setCredentials({})
      })
    return () => {
      cancelled = true
    }
  }, [])

  const effectiveSettings: UserOcrSettings = useMemo(
    () => settings ?? DEFAULT_OCR_SETTINGS,
    [settings]
  )

  const handleChange = useCallback((next: UserOcrSettings) => {
    void saveSettings({ ocrSettings: next }).catch((err) => {
      toast.error(err instanceof Error ? err.message : String(err))
    })
  }, [])

  const handleCredentialChange = useCallback((providerId: string, key: string, value: string) => {
    setCredentials((prev) => {
      const next = { ...(prev ?? {}) }
      const entry = { ...(next[providerId] ?? {}) }
      if (value) entry[key] = value
      else delete entry[key]
      next[providerId] = entry
      return next
    })
    void setOcrSecret(providerId, key, value).catch((err) => {
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

  const ocrDepsFactory = useCallback(
    () => buildOcrDeps({ settings: effectiveSettings }),
    [effectiveSettings]
  )

  // Hold render until stored credentials have loaded so the first-visit wizard's
  // "no cloud credentials yet" check and the per-provider configured badges
  // reflect the keyring rather than flashing an empty state.
  if (credentials === null) return null

  return (
    <OcrSection
      settings={effectiveSettings}
      credentials={credentials}
      onChange={handleChange}
      onCredentialChange={handleCredentialChange}
      onClearCache={handleClearCache}
      onClearProviderCache={handleClearProviderCache}
      ocrDepsFactory={ocrDepsFactory}
    />
  )
}
