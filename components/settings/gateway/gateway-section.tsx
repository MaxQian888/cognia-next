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

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, CopyIcon, NetworkIcon, PlusIcon } from "lucide-react"
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
  gatewayListCooldowns,
  gatewayStart,
  gatewayStop,
  gatewayUpdateConfig,
} from "@/lib/tauri/gateway"
import {
  DEFAULT_GATEWAY_CONFIG,
  type GatewayBindInterface,
  type GatewayConfig,
  type GatewayKeyCooldown,
  type GatewayStatus,
} from "@/types/gateway"
import { GatewayKeysCard } from "./gateway-keys-card"
import { GatewayLogViewer } from "./gateway-log-viewer"

/** Add/remove chip list backed by a string[] — used for allowlist / exposed
 * models / retry status codes.
 *
 * The draft is controlled state, not a ref, and commits on Enter OR blur: the
 * earlier ref-backed version silently discarded anything typed but not
 * Enter-ed, which looked exactly like a save that didn't stick. */
function ChipInput({
  values,
  onCommit,
  placeholder,
  ariaLabel,
  addLabel,
  removeLabel,
}: {
  values: string[]
  onCommit: (next: string[]) => void
  placeholder: string
  ariaLabel: string
  addLabel: string
  removeLabel: string
}) {
  const [draft, setDraft] = useState("")

  const commitDraft = () => {
    const value = draft.trim()
    if (value && !values.includes(value)) onCommit([...values, value])
    setDraft("")
  }

  return (
    <div className="space-y-2">
      {values.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {values.map((entry) => (
            <span
              key={entry}
              className="flex items-center gap-1 rounded bg-muted py-1 pl-2 pr-1 font-mono text-xs"
            >
              {entry}
              <button
                type="button"
                className="rounded-sm px-1 text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                aria-label={`${removeLabel} ${entry}`}
                onClick={() => onCommit(values.filter((e) => e !== entry))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Input
          value={draft}
          placeholder={placeholder}
          aria-label={ariaLabel}
          className="font-mono text-xs"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return
            e.preventDefault()
            commitDraft()
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!draft.trim()}
          // Qualified by the field: six buttons all named "Add" are ambiguous
          // to a screen reader (and indistinguishable to a test).
          aria-label={`${addLabel} ${ariaLabel}`}
          // Commit on mousedown, NOT click: mousedown blurs the input, whose
          // onBlur commits and clears the draft, which renders this button
          // disabled — so an onClick handler would never fire and the button
          // would be decorative. Ordering mousedown first makes the button the
          // thing that actually commits; the blur that follows sees an empty
          // draft and no-ops.
          onMouseDown={commitDraft}
        >
          <PlusIcon className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}

export function GatewaySection() {
  const t = useTranslations("settings.gateway")
  const desktop = isTauri()

  const [config, setConfig] = useState<GatewayConfig>(DEFAULT_GATEWAY_CONFIG)
  const [status, setStatus] = useState<GatewayStatus | null>(null)
  const [cooldowns, setCooldowns] = useState<GatewayKeyCooldown[]>([])

  const refreshStatus = () =>
    gatewayGetStatus()
      .then(setStatus)
      .catch(() => {})

  const refreshCooldowns = () =>
    gatewayListCooldowns()
      .then(setCooldowns)
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
    gatewayListCooldowns()
      .then(setCooldowns)
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

          <NumberRow
            id="gw-port"
            label={t("port")}
            value={config.port}
            min={1024}
            max={65535}
            fallback={DEFAULT_GATEWAY_CONFIG.port}
            onCommit={(v) => void persist({ port: v })}
          />

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
              addLabel={t("add")}
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
              addLabel={t("add")}
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
              addLabel={t("add")}
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

      {/* Upstream protection (cooldown + concurrency + field stripping) */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">{t("concurrencyHeading")}</CardTitle>
          <CardDescription>{t("concurrencyHelp")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <NumberRow
            id="gw-cc-per-key"
            label={t("maxConcurrentPerKey")}
            help={t("maxConcurrentPerKeyHelp")}
            value={config.maxConcurrentPerKey}
            min={0}
            max={1000}
            fallback={0}
            onCommit={(v) => void persist({ maxConcurrentPerKey: v })}
          />
          <NumberRow
            id="gw-cc-per-upstream"
            label={t("maxConcurrentPerUpstreamKey")}
            help={t("maxConcurrentPerUpstreamKeyHelp")}
            value={config.maxConcurrentPerUpstreamKey}
            min={0}
            max={1000}
            fallback={0}
            onCommit={(v) => void persist({ maxConcurrentPerUpstreamKey: v })}
          />
          <NumberRow
            id="gw-cc-wait"
            label={t("concurrencyWait")}
            help={t("concurrencyWaitHelp")}
            value={config.concurrencyWaitMs}
            min={0}
            max={120000}
            fallback={10000}
            onCommit={(v) => void persist({ concurrencyWaitMs: v })}
          />
          <NumberRow
            id="gw-cooldown-fallback"
            label={t("cooldownFallback")}
            help={t("cooldownFallbackHelp")}
            value={config.cooldownFallbackSecs}
            min={0}
            max={3600}
            fallback={20}
            onCommit={(v) => void persist({ cooldownFallbackSecs: v })}
          />
          <NumberRow
            id="gw-overload-cooldown"
            label={t("overloadCooldown")}
            help={t("overloadCooldownHelp")}
            value={config.overloadCooldownSecs}
            min={0}
            max={3600}
            fallback={600}
            onCommit={(v) => void persist({ overloadCooldownSecs: v })}
          />

          <div className="space-y-2">
            <Label>{t("disableKeywords")}</Label>
            <ChipInput
              values={config.disableKeywords}
              onCommit={(next) => void persist({ disableKeywords: next })}
              placeholder={t("disableKeywordsPlaceholder")}
              ariaLabel={t("disableKeywords")}
              addLabel={t("add")}
              removeLabel={t("remove")}
            />
            <p className="text-xs text-muted-foreground">{t("disableKeywordsHelp")}</p>
          </div>

          <div className="space-y-2">
            <Label>{t("strippedFields")}</Label>
            <ChipInput
              values={config.strippedRequestFields}
              onCommit={(next) => void persist({ strippedRequestFields: next })}
              placeholder={t("strippedFieldsPlaceholder")}
              ariaLabel={t("strippedFields")}
              addLabel={t("add")}
              removeLabel={t("remove")}
            />
            <p className="text-xs text-muted-foreground">{t("strippedFieldsHelp")}</p>
          </div>

          <div className="space-y-2">
            <Label>{t("fieldStripAllow")}</Label>
            <ChipInput
              values={config.fieldStripAllow}
              onCommit={(next) => void persist({ fieldStripAllow: next })}
              placeholder={t("fieldStripAllowPlaceholder")}
              ariaLabel={t("fieldStripAllow")}
              addLabel={t("add")}
              removeLabel={t("remove")}
            />
            <p className="text-xs text-muted-foreground">{t("fieldStripAllowHelp")}</p>
          </div>

          {/* Parked upstream accounts (W3.1 visibility) */}
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label>{t("cooldownsHeading")}</Label>
              <Button size="sm" variant="outline" onClick={() => void refreshCooldowns()}>
                {t("cooldownsRefresh")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("cooldownsHelp")}</p>
            {cooldowns.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("cooldownsEmpty")}</p>
            ) : (
              <ul className="space-y-1">
                {cooldowns.map((c) => (
                  <li
                    key={`${c.providerId}-${c.keyHint}`}
                    className="flex items-center justify-between gap-2 rounded bg-muted px-2 py-1 text-xs"
                  >
                    <span className="font-mono">
                      {c.providerId} · {c.keyHint}
                    </span>
                    <span
                      className={
                        c.permanent ? "text-destructive" : "text-amber-600 dark:text-amber-400"
                      }
                    >
                      {c.permanent
                        ? t("cooldownsPermanent")
                        : t("cooldownsCoolingUntil", {
                            time: new Date(c.untilMs).toLocaleTimeString(),
                          })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Request log */}
      <GatewayLogViewer />
    </div>
  )
}

/** Label + bounded number input, committed on blur / Enter rather than on every
 * keystroke.
 *
 * Clamping per keystroke made these fields unusable: with `min` 1024 the port
 * box turned the first digit of "8080" into 1024 and typing could never recover,
 * and an empty field parsed as NaN and snapped back to the default so the value
 * could not be cleared and retyped. Deferring the clamp to commit also collapses
 * one Tauri IPC + disk write per keystroke into one per edit. */
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
  const [draft, setDraft] = useState<string | null>(null)

  const commitDraft = () => {
    if (draft === null) return
    const raw = Number.parseInt(draft, 10)
    const next = Number.isFinite(raw) ? Math.min(max, Math.max(min, raw)) : fallback
    setDraft(null)
    if (next !== value) onCommit(next)
  }

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
          // `draft` is null while not editing, so the field tracks external
          // config reloads; once the user types it owns the value verbatim.
          value={draft ?? String(value)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return
            e.preventDefault()
            commitDraft()
          }}
        />
      </div>
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  )
}

export default GatewaySection
