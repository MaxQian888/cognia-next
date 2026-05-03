"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { CheckCircle2Icon, KeyRoundIcon, PlusIcon, ShieldIcon, XIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useRemoteControlStore } from "@/stores/remote-control/store"
import { WEBHOOK_DELIVERY_LIMITS } from "@/lib/scheduler/notification-integration"

export function OutboundTab() {
  const t = useTranslations("settings.remoteControl.outbound")
  const outbound = useRemoteControlStore((s) => s.config.outbound)
  const setSigningSecret = useRemoteControlStore((s) => s.setSigningSecret)
  const setOutboundHeaders = useRemoteControlStore((s) => s.setOutboundHeaders)

  const [pendingSecret, setPendingSecret] = useState("")

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
    await setOutboundHeaders([...outbound.defaultHeaders, { name: "", value: "" }])
  }

  const onUpdateHeader = async (index: number, patch: { name?: string; value?: string }) => {
    const next = outbound.defaultHeaders.map((h, i) => (i === index ? { ...h, ...patch } : h))
    await setOutboundHeaders(next)
  }

  const onRemoveHeader = async (index: number) => {
    const next = outbound.defaultHeaders.filter((_, i) => i !== index)
    await setOutboundHeaders(next)
  }

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
          <CardTitle className="text-sm font-medium">{t("retryConfigHeading")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            {t("retryConfigSummary", {
              retries: WEBHOOK_DELIVERY_LIMITS.retries,
              baseDelayMs: WEBHOOK_DELIVERY_LIMITS.baseDelayMs,
              timeoutMs: WEBHOOK_DELIVERY_LIMITS.timeoutMs,
            })}
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
