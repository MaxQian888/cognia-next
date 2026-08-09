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
import { useTranslations } from "next-intl"
import { OcrSection, OCR_PROVIDER_REGISTRY } from "./ocr-section"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { clearOcrCache, clearOcrCacheForProvider } from "@/lib/db/ocr-results"
import { buildOcrDeps } from "@/lib/ocr/deps"
import { getOcrSecret, setOcrSecret } from "@/lib/ocr/credentials"
import { DEFAULT_OCR_SETTINGS, type UserOcrSettings } from "@/types/ocr"
import type { OcrRuntimeStatus } from "@cognia/ocr/runtime-status"

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
  const t = useTranslations()
  const settings = useLiveQuery(async () => (await getSettings()).ocrSettings, [])
  const [credentials, setCredentials] = useState<Record<string, Record<string, string>> | null>(
    null
  )
  const [runtimeStatuses, setRuntimeStatuses] = useState<Record<string, OcrRuntimeStatus>>({})
  const migratedLegacyKeyRef = React.useRef<string | null>(null)
  const normalizedDefaultRef = React.useRef<string | null>(null)

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

  useEffect(() => {
    const localConfig = effectiveSettings.providerConfig["local-http"] ?? {}
    const legacyKey = typeof localConfig.apiKey === "string" ? localConfig.apiKey.trim() : ""
    if (!legacyKey || migratedLegacyKeyRef.current === legacyKey) return
    migratedLegacyKeyRef.current = legacyKey
    let cancelled = false
    void (async () => {
      const existing = await getOcrSecret("local-http", "apiKey").catch(() => null)
      if (!existing) await setOcrSecret("local-http", "apiKey", legacyKey)
      if (cancelled) return
      setCredentials((previous) => ({
        ...(previous ?? {}),
        "local-http": { ...(previous?.["local-http"] ?? {}), apiKey: existing ?? legacyKey },
      }))
      const nextLocalConfig = { ...localConfig }
      delete nextLocalConfig.apiKey
      await saveSettings({
        ocrSettings: {
          ...effectiveSettings,
          providerConfig: {
            ...effectiveSettings.providerConfig,
            "local-http": nextLocalConfig,
          },
        },
      })
    })().catch((error) => {
      migratedLegacyKeyRef.current = null
      toast.error(error instanceof Error ? error.message : String(error))
    })
    return () => {
      cancelled = true
    }
  }, [effectiveSettings])

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
      toast.success(t("ocr.cache.cleared", { count: removed }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }, [t])

  const handleClearProviderCache = useCallback(
    async (providerId: string) => {
      try {
        const removed = await clearOcrCacheForProvider(providerId)
        toast.success(t("ocr.cache.toastProviderCleared", { count: removed }))
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      }
    },
    [t]
  )

  const ocrDepsFactory = useCallback(
    () => buildOcrDeps({ settings: effectiveSettings }),
    [effectiveSettings]
  )

  useEffect(() => {
    let cancelled = false
    const deps = buildOcrDeps({ settings: effectiveSettings })
    if (!deps.runtimeStatus) return
    void Promise.all(
      deps.registry.list().map(async (provider) => {
        const status = await deps.runtimeStatus!(provider, deps.platform)
        return [provider.id, status] as const
      })
    ).then((entries) => {
      if (cancelled) return
      const statuses = Object.fromEntries(entries)
      setRuntimeStatuses(statuses)
      const savedDefault = effectiveSettings.defaultProviderId
      const status = savedDefault === "auto" ? undefined : statuses[savedDefault]
      const defaultIsMissing =
        savedDefault !== "auto" &&
        !deps.registry.list().some((provider) => provider.id === savedDefault)
      if (
        savedDefault !== "auto" &&
        (defaultIsMissing || (status && !status.ready)) &&
        normalizedDefaultRef.current !== savedDefault
      ) {
        normalizedDefaultRef.current = savedDefault
        handleChange({ ...effectiveSettings, defaultProviderId: "auto" })
        const reason = status?.reason
          ? t(`ocr.runtime.reasons.${status.reason}`)
          : t("ocr.compare.runtimeNotReady")
        toast.warning(t("ocr.runtime.defaultNormalized", { provider: savedDefault, reason }))
      }
    })
    return () => {
      cancelled = true
    }
  }, [effectiveSettings, credentials, handleChange, t])

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
      runtimeStatuses={runtimeStatuses}
    />
  )
}
