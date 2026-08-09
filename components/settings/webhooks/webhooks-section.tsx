"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  CheckCircle2Icon,
  KeyRoundIcon,
  PlusIcon,
  RotateCcwIcon,
  SendIcon,
  ShieldIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useWebhookStore } from "@/stores/webhooks/store"
import {
  DEFAULT_WEBHOOK_DELIVERY,
  normalizeWebhookDelivery,
  OUTBOUND_EVENT_TYPES,
  WEBHOOK_DELIVERY_BOUNDS,
  type WebhookDeliveryConfig,
  type WebhookEndpoint,
} from "@/types/webhooks"

/** Accepts a non-empty absolute http(s) URL. Empty is allowed (draft endpoint). */
function isValidEndpointUrl(raw: string): boolean {
  const trimmed = raw.trim()
  if (!trimmed) return true
  try {
    const u = new URL(trimmed)
    return u.protocol === "http:" || u.protocol === "https:"
  } catch {
    return false
  }
}

export function WebhooksSection() {
  const t = useTranslations("settings.remoteControl.outbound")
  const outbound = useWebhookStore((state) => state.config)
  const setSigningSecret = useWebhookStore((state) => state.setSigningSecret)
  const setDefaultHeaders = useWebhookStore((state) => state.setDefaultHeaders)
  const updateConfig = useWebhookStore((state) => state.updateConfig)

  const [pendingSecret, setPendingSecret] = useState("")
  const endpoints = outbound.endpoints ?? []
  const delivery = outbound.delivery ?? DEFAULT_WEBHOOK_DELIVERY

  const onAddEndpoint = async () => {
    const next: WebhookEndpoint = {
      id: crypto.randomUUID(),
      name: "",
      url: "",
      headers: [],
      enabled: true,
      eventTypes: [],
    }
    await updateConfig({ endpoints: [...endpoints, next] })
  }

  const onUpdateEndpoint = async (id: string, patch: Partial<WebhookEndpoint>) => {
    await updateConfig({
      endpoints: endpoints.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    })
  }

  const onRemoveEndpoint = async (id: string) => {
    await updateConfig({ endpoints: endpoints.filter((e) => e.id !== id) })
  }

  const onToggleSubscription = (endpoint: WebhookEndpoint, eventType: string, on: boolean) => {
    const current = endpoint.eventTypes ?? []
    const next = on ? [...current, eventType] : current.filter((e) => e !== eventType)
    void onUpdateEndpoint(endpoint.id, { eventTypes: next })
  }

  const onAddEndpointHeader = (endpoint: WebhookEndpoint) => {
    void onUpdateEndpoint(endpoint.id, { headers: [...endpoint.headers, { name: "", value: "" }] })
  }

  const onUpdateEndpointHeader = (
    endpoint: WebhookEndpoint,
    index: number,
    patch: { name?: string; value?: string }
  ) => {
    const headers = endpoint.headers.map((h, i) => (i === index ? { ...h, ...patch } : h))
    void onUpdateEndpoint(endpoint.id, { headers })
  }

  const onRemoveEndpointHeader = (endpoint: WebhookEndpoint, index: number) => {
    void onUpdateEndpoint(endpoint.id, {
      headers: endpoint.headers.filter((_, i) => i !== index),
    })
  }

  const onTestEndpoint = async (endpoint: WebhookEndpoint) => {
    if (!endpoint.url) {
      toast.error(t("endpointUrlRequired"))
      return
    }
    try {
      const [{ deliverWebhook }, { getWebhookSigningSecret }] = await Promise.all([
        import("@/lib/webhooks/delivery"),
        import("@/lib/webhooks/signing-secret"),
      ])
      const signingSecret = await getWebhookSigningSecret()
      if (outbound.hasSigningSecret && !signingSecret) {
        throw new Error(t("secretUnavailable"))
      }
      const result = await deliverWebhook({
        endpoint,
        event: {
          id: crypto.randomUUID(),
          eventType: "webhooks.test",
          source: "webhooks",
          payload: { test: true },
          occurredAt: new Date().toISOString(),
        },
        signingSecret: signingSecret ?? undefined,
        limits: delivery,
      })
      if (result.ok) toast.success(t("endpointTestOk"))
      else
        toast.error(t("endpointTestFailed", { error: result.error ?? String(result.httpStatus) }))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  const onSaveSecret = async () => {
    if (!pendingSecret) {
      toast.error(t("secretMissing"))
      return
    }
    const result = await setSigningSecret(pendingSecret)
    if (!result.ok) {
      toast.error(t("secretSaveError", { error: result.error ?? "" }))
      return
    }
    setPendingSecret("")
    toast.success(t("secretSaved"))
  }

  const onClearSecret = async () => {
    const result = await setSigningSecret(null)
    if (!result.ok) {
      toast.error(t("secretSaveError", { error: result.error ?? "" }))
      return
    }
    toast.success(t("secretCleared"))
  }

  const onAddHeader = async () => {
    await setDefaultHeaders([...outbound.defaultHeaders, { name: "", value: "" }])
  }

  const onUpdateHeader = async (index: number, patch: { name?: string; value?: string }) => {
    const next = outbound.defaultHeaders.map((h, i) => (i === index ? { ...h, ...patch } : h))
    await setDefaultHeaders(next)
  }

  const onRemoveHeader = async (index: number) => {
    const next = outbound.defaultHeaders.filter((_, i) => i !== index)
    await setDefaultHeaders(next)
  }

  const onUpdateDelivery = (patch: Partial<WebhookDeliveryConfig>) => {
    void updateConfig({ delivery: normalizeWebhookDelivery({ ...delivery, ...patch }) })
  }

  const onResetDelivery = () => {
    void updateConfig({ delivery: { ...DEFAULT_WEBHOOK_DELIVERY } })
    toast.success(t("deliveryResetDone"))
  }

  const deliveryFields = [
    {
      key: "maxRetries" as const,
      label: t("deliveryMaxRetries"),
      help: t("deliveryMaxRetriesHelp"),
      bounds: WEBHOOK_DELIVERY_BOUNDS.maxRetries,
      step: 1,
    },
    {
      key: "timeoutMs" as const,
      label: t("deliveryTimeoutMs"),
      help: t("deliveryTimeoutMsHelp"),
      bounds: WEBHOOK_DELIVERY_BOUNDS.timeoutMs,
      step: 500,
    },
    {
      key: "baseDelayMs" as const,
      label: t("deliveryBaseDelayMs"),
      help: t("deliveryBaseDelayMsHelp"),
      bounds: WEBHOOK_DELIVERY_BOUNDS.baseDelayMs,
      step: 100,
    },
  ]

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <ShieldIcon className="h-4 w-4" />
            {t("heading")}
          </CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <KeyRoundIcon className="h-3.5 w-3.5 text-muted-foreground" />
            {outbound.hasSigningSecret ? (
              <span className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                <CheckCircle2Icon className="h-3.5 w-3.5" />
                {t("secretSet")}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">{t("secretMissing")}</span>
            )}
          </div>
          <Label htmlFor="rc-outbound-secret">{t("signingSecret")}</Label>
          <p className="text-xs text-muted-foreground">{t("signingSecretHelp")}</p>
          <div className="flex items-center gap-2">
            <Input
              id="rc-outbound-secret"
              type="password"
              autoComplete="new-password"
              placeholder={t("secretPlaceholder")}
              value={pendingSecret}
              onChange={(e) => setPendingSecret(e.target.value)}
            />
            <Button size="sm" onClick={onSaveSecret}>
              {t("setSecret")}
            </Button>
            {outbound.hasSigningSecret && (
              <Button size="sm" variant="outline" onClick={onClearSecret}>
                {t("clearSecret")}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">{t("endpointsHeading")}</CardTitle>
          <CardDescription>{t("endpointsHelp")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {endpoints.length === 0 && (
            <p className="text-xs text-muted-foreground">{t("endpointsEmpty")}</p>
          )}
          {endpoints.map((endpoint) => {
            const urlValid = isValidEndpointUrl(endpoint.url)
            const subs = endpoint.eventTypes ?? []
            return (
              <div key={endpoint.id} className="space-y-3 rounded-md border p-3">
                <div className="flex items-center gap-2">
                  <Input
                    placeholder={t("endpointName")}
                    value={endpoint.name}
                    onChange={(e) => onUpdateEndpoint(endpoint.id, { name: e.target.value })}
                    className="flex-1"
                  />
                  <Switch
                    checked={endpoint.enabled}
                    onCheckedChange={(v) => onUpdateEndpoint(endpoint.id, { enabled: v })}
                    aria-label={t("endpointEnabled")}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onTestEndpoint(endpoint)}
                    aria-label={t("endpointTest")}
                  >
                    <SendIcon className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onRemoveEndpoint(endpoint.id)}
                    aria-label={t("endpointRemove")}
                  >
                    <XIcon className="h-4 w-4" />
                  </Button>
                </div>
                <div className="space-y-1">
                  <Input
                    placeholder={t("endpointUrlPlaceholder")}
                    value={endpoint.url}
                    aria-invalid={!urlValid}
                    onChange={(e) => onUpdateEndpoint(endpoint.id, { url: e.target.value })}
                  />
                  {!urlValid && (
                    <p role="alert" className="text-xs text-destructive">
                      {t("endpointUrlInvalid")}
                    </p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <Label className="text-xs font-medium">{t("subscriptionsLabel")}</Label>
                    <span className="text-[11px] text-muted-foreground">
                      {t("subscriptionSummary", { count: subs.length })}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">{t("subscriptionsHelp")}</p>
                  <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                    {OUTBOUND_EVENT_TYPES.map((et) => {
                      const id = `rc-sub-${endpoint.id}-${et}`
                      return (
                        <label
                          key={et}
                          htmlFor={id}
                          className="flex items-center gap-2 rounded-md border bg-muted/20 px-2 py-1.5 text-xs"
                        >
                          <Checkbox
                            id={id}
                            checked={subs.includes(et)}
                            onCheckedChange={(v) => onToggleSubscription(endpoint, et, v === true)}
                          />
                          {t(`eventType_${et}` as never)}
                        </label>
                      )
                    })}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t("endpointHeadersLabel")}</Label>
                  <p className="text-xs text-muted-foreground">{t("endpointHeadersHelp")}</p>
                  {endpoint.headers.map((header, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <Input
                        placeholder={t("headerName")}
                        value={header.name}
                        onChange={(e) =>
                          onUpdateEndpointHeader(endpoint, index, { name: e.target.value })
                        }
                        className="flex-1"
                      />
                      <Input
                        placeholder={t("headerValue")}
                        value={header.value}
                        onChange={(e) =>
                          onUpdateEndpointHeader(endpoint, index, { value: e.target.value })
                        }
                        className="flex-1"
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onRemoveEndpointHeader(endpoint, index)}
                        aria-label={t("removeHeader")}
                      >
                        <XIcon className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                  <Button size="sm" variant="outline" onClick={() => onAddEndpointHeader(endpoint)}>
                    <PlusIcon className="mr-2 h-3.5 w-3.5" />
                    {t("endpointAddHeader")}
                  </Button>
                </div>
              </div>
            )
          })}
          <Button size="sm" variant="outline" onClick={onAddEndpoint}>
            <PlusIcon className="mr-2 h-3.5 w-3.5" />
            {t("addEndpoint")}
          </Button>
          <p className="text-xs text-muted-foreground">{t("endpointsSchemeNote")}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">{t("defaultHeaders")}</CardTitle>
          <CardDescription>{t("defaultHeadersHelp")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {outbound.defaultHeaders.length === 0 && (
            <p className="text-xs text-muted-foreground">{t("perTaskHint")}</p>
          )}
          {outbound.defaultHeaders.map((header, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input
                placeholder={t("headerName")}
                value={header.name}
                onChange={(e) => onUpdateHeader(index, { name: e.target.value })}
                className="flex-1"
              />
              <Input
                placeholder={t("headerValue")}
                value={header.value}
                onChange={(e) => onUpdateHeader(index, { value: e.target.value })}
                className="flex-1"
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onRemoveHeader(index)}
                aria-label={t("removeHeader")}
              >
                <XIcon className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button size="sm" variant="outline" onClick={onAddHeader}>
            <PlusIcon className="mr-2 h-3.5 w-3.5" />
            {t("addHeader")}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="space-y-1">
              <CardTitle className="text-sm font-medium">{t("deliveryHeading")}</CardTitle>
              <CardDescription>{t("deliveryHelp")}</CardDescription>
            </div>
            <Button size="sm" variant="ghost" onClick={onResetDelivery}>
              <RotateCcwIcon className="mr-1.5 h-3.5 w-3.5" />
              {t("deliveryReset")}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {deliveryFields.map((field) => (
            <div key={field.key} className="space-y-1">
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor={`rc-delivery-${field.key}`} className="flex-1">
                  {field.label}
                </Label>
                <Input
                  id={`rc-delivery-${field.key}`}
                  type="number"
                  min={field.bounds.min}
                  max={field.bounds.max}
                  step={field.step}
                  className="w-32"
                  value={delivery[field.key]}
                  onChange={(e) =>
                    onUpdateDelivery({
                      [field.key]: Number.parseInt(e.target.value || "0", 10),
                    } as Partial<WebhookDeliveryConfig>)
                  }
                />
              </div>
              <p className="text-xs text-muted-foreground">{field.help}</p>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
