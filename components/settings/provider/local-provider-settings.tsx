"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Download, ExternalLink, Key } from "lucide-react"
import { useTranslations } from "next-intl"
import type {
  ProviderModelDiscoveryEntry,
  UserProviderSettings,
} from "@cognia/provider-types/provider"
import type {
  LocalProviderName,
  LocalServerStatus,
  LocalModelInfo,
} from "@cognia/provider-types/local-provider"
import { LOCAL_PROVIDER_CONFIGS } from "@cognia/provider-core/providers/local-providers"
import {
  createLocalProviderService,
  getInstallInstructions,
} from "@cognia/provider-core/providers/local-provider-service"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useSettingsStore } from "@/stores/settings"
import { useDraftField } from "@/hooks/settings/use-draft-field"
import { LocalProviderCard } from "./local-provider-card"
import { LocalProviderSetupWizard } from "./local-provider-setup-wizard"
import { TransportHeadersEditor } from "./transport-headers-editor"

export interface LocalProviderSettingsProps {
  providerId: LocalProviderName
}

function toDiscoveredModels(models: LocalModelInfo[]): ProviderModelDiscoveryEntry[] {
  return models.map((model) => ({
    id: model.id,
    name: model.id,
    provider: model.owned_by,
    contextLength: model.context_length,
  }))
}

function resolveNextDefaultModel(
  current: UserProviderSettings | undefined,
  models: ProviderModelDiscoveryEntry[]
): string | undefined {
  if (models.length === 0) return undefined
  const currentDefault = current?.defaultModel?.trim()
  if (currentDefault && models.some((model) => model.id === currentDefault)) {
    return undefined
  }
  return (
    current?.enabledModels?.find((id) => models.some((model) => model.id === id)) ?? models[0]?.id
  )
}

export function LocalProviderSettings({ providerId }: LocalProviderSettingsProps) {
  const t = useTranslations("providers")
  const providerSettings = useSettingsStore((state) => state.providerSettings)
  const setProviderConfig = useSettingsStore((state) => state.setProviderConfig)

  const [status, setStatus] = useState<LocalServerStatus | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [showSetupWizard, setShowSetupWizard] = useState(false)

  const settings = providerSettings[providerId]
  const config = LOCAL_PROVIDER_CONFIGS[providerId]
  const installInfo = getInstallInstructions(providerId)
  const effectiveBaseUrl = settings?.baseURL?.trim() || config.defaultBaseURL
  const apiKey = settings?.apiKey?.trim() || undefined
  const customHeaders = settings?.customHeaders

  const serviceOptions = useMemo(
    () => ({ baseUrl: effectiveBaseUrl, apiKey, customHeaders }),
    [effectiveBaseUrl, apiKey, customHeaders]
  )

  const refreshStatus = useCallback(async () => {
    setIsRefreshing(true)
    try {
      const nextStatus = await createLocalProviderService(providerId, serviceOptions).getStatus()
      setStatus(nextStatus)
      return nextStatus
    } finally {
      setIsRefreshing(false)
    }
  }, [providerId, serviceOptions])

  // Probe on mount and whenever the COMMITTED endpoint / key / headers change.
  // The inputs below are draft-buffered, so a keystroke no longer reaches the
  // store (and this effect) until the user pauses; the short delay here also
  // coalesces the two writes a base-URL + key edit can produce.
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      void refreshStatus()
    }, 150)

    return () => clearTimeout(timeoutId)
  }, [refreshStatus])

  const setApiKey = useCallback(
    (apiKey: string) => void setProviderConfig(providerId, { apiKey }),
    [providerId, setProviderConfig]
  )
  const apiKeyField = useDraftField(settings?.apiKey ?? "", setApiKey, { identity: providerId })

  const persistDiscoveredModels = useCallback(
    async (models: LocalModelInfo[]) => {
      const discoveredModels = toDiscoveredModels(models)
      const nextDefaultModel = resolveNextDefaultModel(settings, discoveredModels)
      await setProviderConfig(providerId, {
        discoveredModels,
        discoveredModelsLastFetched: Date.now(),
        ...(nextDefaultModel ? { defaultModel: nextDefaultModel } : {}),
      })
    },
    [providerId, setProviderConfig, settings]
  )

  const handleTestConnection = useCallback(async () => {
    setIsRefreshing(true)
    try {
      const service = createLocalProviderService(providerId, serviceOptions)
      const nextStatus = await service.getStatus()
      setStatus(nextStatus)

      if (nextStatus.connected) {
        let models: LocalModelInfo[]
        try {
          models = await service.listModels()
        } catch (error) {
          const message = error instanceof Error ? error.message : t("connectionFailed")
          await setProviderConfig(providerId, {
            verificationStatus: "unverified",
            lastVerifiedAt: Date.now(),
            verificationMessage: message,
            healthStatus: "error",
          })
          return {
            success: false,
            message,
            latency: nextStatus.latency_ms,
          }
        }
        await persistDiscoveredModels(models)
        const message = t("connectedSummary", {
          version: nextStatus.version || t("unknownVersion"),
          count: models.length,
        })
        await setProviderConfig(providerId, {
          verificationStatus: "verified",
          lastVerifiedAt: Date.now(),
          verificationMessage: message,
          healthStatus: "healthy",
        })
        return {
          success: true,
          message,
          latency: nextStatus.latency_ms,
        }
      }

      const message = nextStatus.error || t("connectionFailed")
      await setProviderConfig(providerId, {
        verificationStatus: "unverified",
        lastVerifiedAt: Date.now(),
        verificationMessage: message,
        healthStatus: "error",
      })
      return {
        success: false,
        message,
        latency: nextStatus.latency_ms,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : t("connectionFailed")
      await setProviderConfig(providerId, {
        verificationStatus: "unverified",
        lastVerifiedAt: Date.now(),
        verificationMessage: message,
        healthStatus: "error",
      })
      return {
        success: false,
        message,
      }
    } finally {
      setIsRefreshing(false)
    }
  }, [persistDiscoveredModels, providerId, serviceOptions, setProviderConfig, t])

  return (
    <TooltipProvider>
      <div className="space-y-6" data-testid="local-provider-settings">
        <LocalProviderCard
          providerId={providerId}
          enabled={settings?.enabled ?? false}
          baseUrl={effectiveBaseUrl}
          isConnected={status?.connected ?? false}
          isLoading={isRefreshing}
          version={status?.version}
          modelsCount={status?.models_count}
          latency={status?.latency_ms}
          error={status?.error}
          onToggle={(enabled) => void setProviderConfig(providerId, { enabled })}
          onBaseUrlChange={(baseURL) => void setProviderConfig(providerId, { baseURL })}
          onTestConnection={handleTestConnection}
          onSetup={() => setShowSetupWizard(true)}
          showToggle={false}
        />

        <div className="space-y-4 rounded-lg border p-4">
          <div className="space-y-2">
            <Label className="flex items-center gap-1.5 text-sm font-medium">
              <Key className="h-3.5 w-3.5" />
              {t("apiKey")}
            </Label>
            <Input
              type="password"
              value={apiKeyField.value}
              onChange={(event) => apiKeyField.onChange(event.target.value)}
              onBlur={apiKeyField.onBlur}
              onKeyDown={apiKeyField.onKeyDown}
              placeholder={t("apiKeyPlaceholder")}
              autoComplete="new-password"
              data-lpignore="true"
              data-form-type="other"
              data-testid="local-provider-api-key-input"
            />
            <p className="text-xs text-muted-foreground">{t("localProviderApiKeyHint")}</p>
          </div>

          <TransportHeadersEditor
            idPrefix={`local-provider-${providerId}-headers`}
            value={settings?.customHeaders}
            onChange={(next) => void setProviderConfig(providerId, { customHeaders: next })}
          />

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setShowSetupWizard(true)}>
              <Download className="mr-1.5 h-3.5 w-3.5" />
              {t("setupGuide")}
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href={installInfo.modelsUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                {t("browseModels")}
              </a>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href={installInfo.docsUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                {t("providerDocumentation", { provider: config.name })}
              </a>
            </Button>
          </div>
        </div>
      </div>

      <Dialog open={showSetupWizard} onOpenChange={setShowSetupWizard}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("providerSetup", { provider: config.name })}</DialogTitle>
            <DialogDescription>{t("followStepsToStart")}</DialogDescription>
          </DialogHeader>
          <LocalProviderSetupWizard
            providerId={providerId}
            baseUrl={effectiveBaseUrl}
            apiKey={apiKey}
            customHeaders={customHeaders}
            onComplete={() => {
              setShowSetupWizard(false)
              void refreshStatus()
            }}
          />
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  )
}

export default LocalProviderSettings
