"use client"

import { useEffect, useId, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { getAllProviders } from "@cognia/provider-types/provider"
import { groupByProvider } from "@cognia/provider-routing/model-option-source"
import { useSettingsStore } from "@/stores/settings"
import { useAccountStore } from "@/stores/account/account-store"
import {
  discoverSubscriptionModels,
  getSubscriptionModel,
} from "@/lib/subscription/core/model-discovery"
import type { ProviderModelDiscoveryEntry } from "@cognia/provider-types"
import { collectModelOptions, resolveModelMeta } from "@/lib/ai/model-options"
import { getSubscriptionProvider } from "@/lib/subscription/core/provider-registry"
import { useAccounts, useSubscriptionProviders } from "@/lib/subscription/core/hooks"
import { canUseCogniaModels } from "@/lib/ai/agent/external/config/gateway-task"
import { ProviderModelList } from "@/components/settings/provider/provider-model-list"
import { ResponsivePicker } from "@/components/shared/responsive-picker"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type {
  ExternalAgentConfig,
  ExternalAgentCogniaModelBinding,
} from "@/types/agent/external-agent"

type RuntimeConfig = Pick<
  ExternalAgentConfig,
  "protocol" | "transport" | "process" | "metadata" | "network"
>

/** Shared by agent and teammate editors without changing app defaults. */
export function CogniaModelPicker({
  config,
  value,
  onChange,
}: {
  config: RuntimeConfig
  value?: ExternalAgentCogniaModelBinding | null
  onChange: (binding: ExternalAgentCogniaModelBinding | null) => void
}) {
  const t = useTranslations("externalAgent.cogniaModel")
  const id = useId()
  const [open, setOpen] = useState(false)
  const providerSettings = useSettingsStore((state) => state.settings?.providerSettings)
  const customProviders = useSettingsStore((state) => state.settings?.customProviders)
  const subscriptions = useSubscriptionProviders()
  const ownerAccountId = useAccountStore((state) => state.unlockedAccountId)
  const subscription = value
    ? (subscriptions.find(
        (entry) =>
          entry.id === value.providerId ||
          entry.plans?.some((plan) => plan.chatProviderId === value.providerId)
      ) ?? getSubscriptionProvider(value.providerId, customProviders))
    : undefined
  const scope = JSON.stringify([value?.providerId, value?.accountId, ownerAccountId])
  const request = useRef<AbortController | null>(null)
  const [catalog, setCatalog] = useState<{
    scope: string
    definition: typeof subscription
    models: ProviderModelDiscoveryEntry[]
  } | null>(null)
  const [discovery, setDiscovery] = useState<{
    scope: string
    definition: typeof subscription
    signal: AbortSignal
    busy: boolean
    error: boolean
  } | null>(null)
  const liveModels =
    catalog?.scope === scope && catalog.definition === subscription ? catalog.models : undefined
  const activeDiscovery =
    discovery?.scope === scope && discovery.definition === subscription && !discovery.signal.aborted
      ? discovery
      : null
  useEffect(() => () => request.current?.abort(), [scope, subscription])
  const scopedSettings = useMemo(() => {
    if (!value?.accountId) return providerSettings
    return {
      ...providerSettings,
      [value.providerId]: {
        providerId: value.providerId,
        defaultModel: value.modelId,
        enabled: true,
        ...providerSettings?.[value.providerId],
        discoveredModels: liveModels ?? [],
      },
    }
  }, [providerSettings, value, liveModels])
  const scopedCustomProviders = useMemo(
    () =>
      customProviders?.map((provider) =>
        value?.accountId && provider.id === value.providerId
          ? { ...provider, discoveredModels: liveModels ?? [] }
          : provider
      ),
    [customProviders, value, liveModels]
  )
  const loadModels = async (detail = false) => {
    if (!subscription || !value?.accountId) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    const progress = { scope, definition: subscription, signal: controller.signal }
    setDiscovery({ ...progress, busy: true, error: false })
    try {
      const input = {
        definition: subscription,
        accountId: value.accountId,
        signal: controller.signal,
      }
      const models = detail
        ? (await getSubscriptionModel({ ...input, model: value.modelId })).model
        : (await discoverSubscriptionModels(input)).models
      if (controller.signal.aborted) return
      if (!models) throw new Error("Model unavailable")
      setCatalog({
        scope,
        definition: subscription,
        models: Array.isArray(models)
          ? models
          : [...(liveModels ?? []).filter((entry) => entry.id !== models.id), models],
      })
      setDiscovery({ ...progress, busy: false, error: false })
    } catch {
      if (!controller.signal.aborted) setDiscovery({ ...progress, busy: false, error: true })
    }
  }
  const supported = canUseCogniaModels(config)
  const options = useMemo(
    () =>
      collectModelOptions(scopedSettings, scopedCustomProviders).filter((model) => {
        const custom = customProviders?.find((provider) => provider.id === model.providerId)
        const provider = getAllProviders()[model.providerId]
        const subscription =
          subscriptions.find((entry) => entry.id === model.providerId) ??
          getSubscriptionProvider(model.providerId, customProviders)
        const protocol =
          custom?.apiProtocol ??
          providerSettings?.[model.providerId]?.apiProtocol ??
          provider?.protocol ??
          subscription?.protocol
        const metadata = resolveModelMeta(
          model.providerId,
          model.modelId,
          scopedSettings,
          scopedCustomProviders
        )
        const settings = custom ?? providerSettings?.[model.providerId]
        const hasManualKey = !!(settings?.apiKey || settings?.apiKeys?.some((key) => key.trim()))
        return (
          (protocol === "openai" || protocol === "anthropic") &&
          metadata.supportsTools !== false &&
          metadata.supportsStreaming !== false &&
          (subscription?.authMode === "api-key" ||
            hasManualKey ||
            provider?.apiKeyRequired === false)
        )
      }),
    [providerSettings, customProviders, subscriptions, scopedSettings, scopedCustomProviders]
  )
  const groups = useMemo(() => groupByProvider(options), [options])
  const metadata = value
    ? resolveModelMeta(value.providerId, value.modelId, scopedSettings, scopedCustomProviders)
    : undefined
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id}>{t("enable")}</Label>
        <Switch
          id={id}
          checked={!!value}
          disabled={!supported && !value}
          onCheckedChange={(checked) => onChange(checked ? { providerId: "", modelId: "" } : null)}
        />
      </div>
      <p className="text-muted-foreground text-xs">
        {t(supported ? "description" : "unsupported")}
      </p>
      {value && (
        <>
          <ResponsivePicker
            open={open}
            onOpenChange={setOpen}
            title={t("model")}
            trigger={
              <Button
                type="button"
                variant="outline"
                className="w-full justify-start"
                disabled={!supported}
                aria-label={t("model")}
              >
                {value.modelId ? `${value.providerId} / ${value.modelId}` : t("choose")}
              </Button>
            }
          >
            <ProviderModelList
              groups={groups}
              activeProviderId={value.providerId}
              activeModelId={value.modelId}
              searchPlaceholder={t("search")}
              emptyLabel={t("empty")}
              onSelect={(providerId, modelId) => {
                onChange({
                  providerId,
                  modelId,
                  ...(providerId === value.providerId && value.accountId !== undefined
                    ? { accountId: value.accountId }
                    : {}),
                })
                setOpen(false)
              }}
            />
          </ResponsivePicker>
          {metadata && (
            <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-xs">
              {metadata.contextLength !== undefined && (
                <span>{t("context", { tokens: metadata.contextLength })}</span>
              )}
              {metadata.maxInputTokens !== undefined && (
                <span>{t("input", { tokens: metadata.maxInputTokens })}</span>
              )}
              {metadata.maxOutputTokens !== undefined && (
                <span>{t("output", { tokens: metadata.maxOutputTokens })}</span>
              )}
              {metadata.maxOutputTokens === undefined && <span>{t("outputUnknown")}</span>}
              {(
                [
                  "supportsTools",
                  "supportsReasoning",
                  "supportsVision",
                  "supportsStructuredOutput",
                ] as const
              ).map((capability) => (
                <span key={capability}>
                  {t("capability", {
                    name: t(capability),
                    status: t(
                      metadata[capability] === undefined
                        ? "unknown"
                        : metadata[capability]
                          ? "supported"
                          : "notSupported"
                    ),
                  })}
                </span>
              ))}
            </div>
          )}
          {subscription?.authMode === "api-key" && (
            <CogniaModelAccount
              key={`${ownerAccountId}:${subscription.id}`}
              providerId={subscription.id}
              value={value}
              onChange={onChange}
            />
          )}
          {subscription?.authMode === "api-key" && subscription.modelApi && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                {subscription.modelApi.list !== false && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!supported || !value.accountId || !!activeDiscovery?.busy}
                    onClick={() => void loadModels()}
                  >
                    {t("refreshModels")}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={
                    !supported || !value.accountId || !value.modelId || !!activeDiscovery?.busy
                  }
                  onClick={() => void loadModels(true)}
                >
                  {t("modelDetails")}
                </Button>
              </div>
              {!value.accountId && (
                <p className="text-muted-foreground text-xs">{t("selectAccountToRefresh")}</p>
              )}
              {activeDiscovery && (
                <p role="status" className="text-muted-foreground text-xs">
                  {t(
                    activeDiscovery.busy
                      ? "loadingModels"
                      : activeDiscovery.error
                        ? "modelsFailed"
                        : "modelsLoaded"
                  )}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function CogniaModelAccount({
  providerId,
  value,
  onChange,
}: {
  providerId: string
  value: ExternalAgentCogniaModelBinding
  onChange: (binding: ExternalAgentCogniaModelBinding) => void
}) {
  const t = useTranslations("externalAgent.cogniaModel")
  const id = useId()
  const { accounts, loading, error, reload } = useAccounts(providerId)
  const missing = !!value.accountId && !accounts.some((account) => account.id === value.accountId)
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{t("account")}</Label>
      <Select
        value={value.accountId === null ? "__manual__" : (value.accountId ?? "__default__")}
        onValueChange={(accountId) =>
          onChange({
            ...value,
            accountId:
              accountId === "__default__"
                ? undefined
                : accountId === "__manual__"
                  ? null
                  : accountId,
          })
        }
        disabled={loading}
      >
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__default__">{t("defaultAccount")}</SelectItem>
          <SelectItem value="__manual__">{t("manualAccount")}</SelectItem>
          {missing && (
            <SelectItem value={value.accountId!} disabled>
              {t("missingAccount")}
            </SelectItem>
          )}
          {accounts.map((account) => (
            <SelectItem key={account.id} value={account.id}>
              {account.label || account.email || account.id}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error && (
        <Button type="button" variant="outline" size="sm" onClick={() => void reload()}>
          {t("retryAccounts")}
        </Button>
      )}
    </div>
  )
}
