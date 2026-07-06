"use client"

/**
 * Inbound LLM Gateway settings (desktop only).
 *
 * A self-contained panel that hydrates from the persisted `gateway_*` config
 * and lets the user run the listener, choose loopback vs LAN binding, tune
 * timeouts / retry / rate limits / allowlist, control model exposure, manage
 * scoped API keys (<GatewayKeysCard>), and inspect the durable request log
 * (<GatewayLogViewer>). Inspired by newapi's channel/token/log surface.
 */

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, CopyIcon, NetworkIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { isTauri } from "@/lib/tauri"
import {
  gatewayGetConfig,
  gatewayGetStatus,
  gatewayStart,
  gatewayStop,
  gatewayUpdateConfig,
} from "@/lib/tauri/gateway"
import {
  DEFAULT_GATEWAY_CONFIG,
  type GatewayBindInterface,
  type GatewayConfig,
  type GatewayStatus,
} from "@/types/gateway"
import { GatewayKeysCard } from "./gateway-keys-card"
import { GatewayLogViewer } from "./gateway-log-viewer"

/** Add/remove chip list backed by a string[] — used for allowlist / exposed
 * models / retry status codes. */
function ChipInput({
  values,
  onCommit,
  placeholder,
  ariaLabel,
  removeLabel,
}: {
  values: string[]
  onCommit: (next: string[]) => void
  placeholder: string
  ariaLabel: string
  removeLabel: string
}) {
  const draftRef = useRef("")
  return (
    <div className="space-y-2">
      {values.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {values.map((entry) => (
            <span
              key={entry}
              className="flex items-center gap-1 rounded bg-muted px-2 py-1 font-mono text-xs"
            >
              {entry}
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                aria-label={`${removeLabel} ${entry}`}
                onClick={() => onCommit(values.filter((e) => e !== entry))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <Input
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="font-mono text-xs"
        onChange={(e) => (draftRef.current = e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return
          const value = draftRef.current.trim()
          if (value && !values.includes(value)) onCommit([...values, value])
          draftRef.current = ""
          ;(e.target as HTMLInputElement).value = ""
        }}
      />
    </div>
  )
}

export function GatewaySection() {
  const t = useTranslations("settings.gateway")
  const desktop = isTauri()

  const [config, setConfig] = useState<GatewayConfig>(DEFAULT_GATEWAY_CONFIG)
  const [status, setStatus] = useState<GatewayStatus | null>(null)

  const refreshStatus = () =>
    gatewayGetStatus()
      .then(setStatus)
      .catch(() => {})

  useEffect(() => {
    if (!desktop) return
    // setState in promise callbacks — external-system updates, not synchronous
    // effect-body writes (react-hooks/set-state-in-effect).
    gatewayGetConfig()
      .then(setConfig)
      .catch(() => {})
    gatewayGetStatus()
      .then(setStatus)
      .catch(() => {})
  }, [desktop])

  if (!desktop) {
    return (
      <div className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
        <AlertTriangleIcon className="mb-2 inline h-4 w-4" /> {t("desktopOnlyNotice")}
      </div>
    )
  }

  const port = status?.boundPort ?? config.port
  const baseUrl = `http://127.0.0.1:${port}`

  const persist = async (patch: Partial<GatewayConfig>) => {
    const next = { ...config, ...patch }
    setConfig(next)
    await gatewayUpdateConfig(next).catch((e) =>
      toast.error(e instanceof Error ? e.message : String(e))
    )
  }

  const onToggleEnabled = async (next: boolean) => {
    if (next && !status?.hasToken) {
      toast.error(t("requiresKey"))
      return
    }
    try {
      if (next) await gatewayStart()
      else await gatewayStop()
      await refreshStatus()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  const copySnippet = async (value: string) => {
    await navigator.clipboard.writeText(value).catch(() => {})
    toast.success(t("copied"))
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Label className="flex items-center gap-2">
          <NetworkIcon className="size-4" />
          {t("title")}
        </Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      {/* Server */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">{t("serverHeading")}</CardTitle>
          <CardDescription>{t("enabledHelp")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="gw-enabled">{t("enabled")}</Label>
            <Switch
              id="gw-enabled"
              disabled={!status?.hasToken}
              checked={status?.running ?? false}
              onCheckedChange={onToggleEnabled}
            />
          </div>
          {!status?.hasToken && <p className="text-xs text-muted-foreground">{t("requiresKey")}</p>}

          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="gw-port" className="flex-1">
              {t("port")}
            </Label>
            <Input
              id="gw-port"
              type="number"
              min={1024}
              max={65535}
              className="w-28"
              value={config.port}
              onChange={(e) => {
                const next = Math.min(
                  65535,
                  Math.max(1024, Number.parseInt(e.target.value || "0", 10) || 47823)
                )
                void persist({ port: next })
              }}
            />
          </div>

          {/* Bind interface */}
          <div className="space-y-2">
            <Label>{t("bindInterface")}</Label>
            <div className="flex gap-1" role="group" aria-label={t("bindInterface")}>
              {(["loopback", "lan"] as const).map((iface) => (
                <Button
                  key={iface}
                  size="sm"
                  variant={config.bindInterface === iface ? "default" : "outline"}
                  onClick={() => void persist({ bindInterface: iface as GatewayBindInterface })}
                >
                  {t(iface === "loopback" ? "bindLoopback" : "bindLan")}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{t("bindHelp")}</p>
            {config.bindInterface === "lan" && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-700 dark:text-amber-400">
                <AlertTriangleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{t("lanWarning")}</span>
              </div>
            )}
          </div>

          {/* Connect snippets */}
          <div className="space-y-2">
            <p className="text-xs font-medium">{t("connectHeading")}</p>
            <p className="text-xs text-muted-foreground">{t("connectHelp")}</p>
            {[
              { label: t("anthropicSnippet"), value: `ANTHROPIC_BASE_URL=${baseUrl}` },
              { label: t("openaiSnippet"), value: `OPENAI_BASE_URL=${baseUrl}/v1` },
            ].map((snippet) => (
              <div key={snippet.label} className="space-y-1">
                <p className="text-xs text-muted-foreground">{snippet.label}</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 truncate rounded bg-muted px-2 py-1 text-xs">
                    {snippet.value}
                  </code>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void copySnippet(snippet.value)}
                  >
                    <CopyIcon className="mr-1.5 h-3.5 w-3.5" />
                    {t("copy")}
                  </Button>
                </div>
              </div>
            ))}
            <p className="text-xs text-muted-foreground">{t("authNote")}</p>
          </div>
        </CardContent>
      </Card>

      {/* API keys */}
      <GatewayKeysCard onChanged={refreshStatus} />

      {/* Reliability & access */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">{t("reliabilityHeading")}</CardTitle>
          <CardDescription>{t("reliabilityHelp")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>{t("allowlist")}</Label>
            <ChipInput
              values={config.allowlist}
              onCommit={(next) => void persist({ allowlist: next })}
              placeholder={t("allowlistPlaceholder")}
              ariaLabel={t("allowlist")}
              removeLabel={t("remove")}
            />
            <p className="text-xs text-muted-foreground">{t("allowlistHelp")}</p>
          </div>

          <NumberRow
            id="gw-rate-limit"
            label={t("rateLimit")}
            value={config.rateLimitPerMin}
            min={1}
            max={60000}
            fallback={600}
            onCommit={(v) => void persist({ rateLimitPerMin: v })}
          />
          <NumberRow
            id="gw-connect-timeout"
            label={t("connectTimeout")}
            help={t("connectTimeoutHelp")}
            value={config.connectTimeoutSecs}
            min={1}
            max={600}
            fallback={30}
            onCommit={(v) => void persist({ connectTimeoutSecs: v })}
          />
          <NumberRow
            id="gw-request-timeout"
            label={t("requestTimeout")}
            help={t("requestTimeoutHelp")}
            value={config.requestTimeoutSecs}
            min={0}
            max={3600}
            fallback={300}
            onCommit={(v) => void persist({ requestTimeoutSecs: v })}
          />
          <NumberRow
            id="gw-max-retries"
            label={t("maxRetries")}
            help={t("maxRetriesHelp")}
            value={config.maxRetries}
            min={0}
            max={20}
            fallback={0}
            onCommit={(v) => void persist({ maxRetries: v })}
          />

          <div className="space-y-2">
            <Label>{t("retryStatusCodes")}</Label>
            <ChipInput
              values={config.retryStatusCodes.map(String)}
              onCommit={(next) =>
                void persist({
                  retryStatusCodes: next
                    .map((s) => Number.parseInt(s, 10))
                    .filter((n) => Number.isFinite(n) && n >= 100 && n <= 599),
                })
              }
              placeholder={t("retryStatusCodesPlaceholder")}
              ariaLabel={t("retryStatusCodes")}
              removeLabel={t("remove")}
            />
            <p className="text-xs text-muted-foreground">{t("retryStatusCodesHelp")}</p>
          </div>

          <p className="text-xs text-muted-foreground">{t("restartHint")}</p>
        </CardContent>
      </Card>

      {/* Model exposure */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">{t("exposureHeading")}</CardTitle>
          <CardDescription>{t("exposureHelp")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>{t("exposedModels")}</Label>
            <ChipInput
              values={config.exposedModels}
              onCommit={(next) => void persist({ exposedModels: next })}
              placeholder={t("exposedModelsPlaceholder")}
              ariaLabel={t("exposedModels")}
              removeLabel={t("remove")}
            />
            <p className="text-xs text-muted-foreground">
              {config.exposedModels.length === 0 ? t("exposedModelsAll") : t("exposedModelsHelp")}
            </p>
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="gw-hide-raw">{t("hideRawModels")}</Label>
              <p className="text-xs text-muted-foreground">{t("hideRawModelsHelp")}</p>
            </div>
            <Switch
              id="gw-hide-raw"
              checked={config.hideRawProviderModels}
              onCheckedChange={(v) => void persist({ hideRawProviderModels: v })}
            />
          </div>
        </CardContent>
      </Card>

      {/* Request log */}
      <GatewayLogViewer />
    </div>
  )
}

function NumberRow({
  id,
  label,
  help,
  value,
  min,
  max,
  fallback,
  onCommit,
}: {
  id: string
  label: string
  help?: string
  value: number
  min: number
  max: number
  fallback: number
  onCommit: (v: number) => void
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor={id} className="flex-1">
          {label}
        </Label>
        <Input
          id={id}
          type="number"
          min={min}
          max={max}
          className="w-28"
          value={value}
          onChange={(e) => {
            const raw = Number.parseInt(e.target.value, 10)
            const next = Number.isFinite(raw) ? Math.min(max, Math.max(min, raw)) : fallback
            onCommit(next)
          }}
        />
      </div>
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  )
}

export default GatewaySection
