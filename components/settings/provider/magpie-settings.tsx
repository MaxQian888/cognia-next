"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { SettingsAlert, SettingsCard } from "@/components/settings/common/settings-section"
import { discoverLocalMagpie } from "@/lib/magpie/client"
import { MAGPIE_APP_KEY } from "@cognia/provider-core/providers/magpie"
import type { UserProviderSettings } from "@cognia/provider-types/provider"

export function MagpieSettings({
  settings,
  onSave,
}: {
  settings?: UserProviderSettings
  onSave: (patch: Partial<UserProviderSettings>) => Promise<void> | void
}) {
  const t = useTranslations("providers.magpie")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState<string | null>(null)
  const pending = useRef<AbortController | null>(null)
  const currentSettings = useRef(settings)
  useEffect(() => {
    currentSettings.current = settings
  }, [settings])
  useEffect(() => () => pending.current?.abort(), [])

  const discover = async () => {
    const controller = new AbortController()
    pending.current?.abort()
    pending.current = controller
    setBusy(true)
    setError(null)
    setVersion(null)
    try {
      const result = await discoverLocalMagpie(controller.signal)
      if (controller.signal.aborted || currentSettings.current !== settings) return
      const defaultModel = result.models.some((m) => m.id === settings?.defaultModel)
        ? settings?.defaultModel
        : result.models[0]?.id
      await onSave({
        baseURL: result.baseURL,
        apiKey: MAGPIE_APP_KEY,
        enabled: result.models.length > 0,
        discoveredModels: result.models,
        discoveredModelsLastFetched: Date.now(),
        defaultModel,
        enabledModels: undefined,
      })
      if (!controller.signal.aborted) setVersion(result.version)
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  return (
    <SettingsCard title={t("title")} description={t("description")}>
      <div className="space-y-3">
        <Button variant="outline" onClick={() => void discover()} disabled={busy}>
          {t(busy ? "discovering" : "discover")}
        </Button>
        {version && (
          <p className="text-sm text-muted-foreground">
            {t("connected", { version, count: settings?.discoveredModels?.length ?? 0 })}
          </p>
        )}
        {error && (
          <SettingsAlert variant="destructive" title={t("failed")}>
            {error}
          </SettingsAlert>
        )}
      </div>
    </SettingsCard>
  )
}
