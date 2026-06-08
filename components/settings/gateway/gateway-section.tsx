"use client"

/**
 * Inbound LLM Gateway settings (desktop only).
 *
 * A self-contained panel — unlike Remote Control it has no Zustand store; the
 * surface is small enough to hold local state and hydrate straight from the
 * `gateway_*` IPC wrappers. Lets the user enable the listener, manage the
 * bearer token, copy the base-URL env snippets external tools need, tune the
 * allowlist / rate limit, and watch the recent-request log.
 */

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertTriangleIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  KeyRoundIcon,
  NetworkIcon,
  RefreshCwIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { isTauri, transport } from "@/lib/tauri"
import {
  gatewayGetStatus,
  gatewayGetToken,
  gatewayRotateToken,
  gatewayStart,
  gatewayStop,
  gatewayUpdateConfig,
} from "@/lib/tauri/gateway"
import {
  DEFAULT_GATEWAY_CONFIG,
  GATEWAY_INBOUND_CALL_EVENT,
  type GatewayConfig,
  type GatewayInboundCall,
  type GatewayStatus,
} from "@/types/gateway"

const MAX_LOG_ENTRIES = 25

export function GatewaySection() {
  const t = useTranslations("settings.gateway")
  const desktop = isTauri()

  const [config, setConfig] = useState<GatewayConfig>(DEFAULT_GATEWAY_CONFIG)
  const [status, setStatus] = useState<GatewayStatus | null>(null)
  const [tokenRevealed, setTokenRevealed] = useState(false)
  const [revealedToken, setRevealedToken] = useState<string | null>(null)
  const [log, setLog] = useState<GatewayInboundCall[]>([])
  const allowlistDraftRef = useRef("")

  // Imperative refresh for event handlers (not referenced by the mount
  // effect, so the linter's set-state-in-effect heuristic stays happy).
  const refresh = () =>
    gatewayGetStatus()
      .then(setStatus)
      .catch(() => {})

  useEffect(() => {
    if (!desktop) return
    // setState runs in the promise callback — an external-system update, not
    // a synchronous effect-body call (react-hooks/set-state-in-effect).
    gatewayGetStatus()
      .then(setStatus)
      .catch(() => {})
  }, [desktop])

  useEffect(() => {
    if (!desktop) return
    const unsubscribe = transport.subscribe<GatewayInboundCall>(
      GATEWAY_INBOUND_CALL_EVENT,
      (entry) => setLog((prev) => [entry, ...prev].slice(0, MAX_LOG_ENTRIES))
    )
    return unsubscribe
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
      toast.error(t("requiresToken"))
      return
    }
    try {
      if (next) await gatewayStart()
      else await gatewayStop()
      await refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  const onRevealToken = async () => {
    try {
      const token = await gatewayGetToken()
      if (!token) return toast.error(t("requiresToken"))
      setRevealedToken(token)
      setTokenRevealed(true)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  const onCopyToken = async () => {
    const token = revealedToken ?? (await gatewayGetToken().catch(() => null))
    if (!token) return toast.error(t("requiresToken"))
    await navigator.clipboard.writeText(token).catch(() => {})
    toast.success(t("tokenCopied"))
  }

  const onRotateToken = async () => {
    try {
      const token = await gatewayRotateToken()
      setRevealedToken(token)
      setTokenRevealed(true)
      await refresh()
      await navigator.clipboard.writeText(token).catch(() => {})
      toast.success(t("tokenCopied"))
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

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">{t("enabled")}</CardTitle>
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
          {!status?.hasToken && (
            <p className="text-xs text-muted-foreground">{t("requiresToken")}</p>
          )}
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <KeyRoundIcon className="h-4 w-4" />
            {t("token")}
          </CardTitle>
          <CardDescription>{t("tokenHelp")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <Input
              readOnly
              value={tokenRevealed ? (revealedToken ?? "") : "••••••••••••••••••••••••••••••••"}
              className="font-mono text-xs"
              aria-label={t("token")}
            />
            <Button size="sm" variant="outline" onClick={onRevealToken}>
              {tokenRevealed ? <EyeOffIcon className="h-4 w-4" /> : <EyeIcon className="h-4 w-4" />}
              <span className="ml-1.5 sr-only">{tokenRevealed ? t("hide") : t("reveal")}</span>
            </Button>
            <Button size="sm" variant="outline" onClick={onCopyToken}>
              <CopyIcon className="h-4 w-4" />
              <span className="ml-1.5 sr-only">{t("copyToken")}</span>
            </Button>
            <Button size="sm" variant="outline" onClick={onRotateToken}>
              <RefreshCwIcon className="h-4 w-4" />
              <span className="ml-1.5 sr-only">{t("rotateToken")}</span>
            </Button>
          </div>
          {!status?.hasToken && (
            <Button size="sm" onClick={onRotateToken}>
              {t("generateToken")}
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">{t("connectHeading")}</CardTitle>
          <CardDescription>{t("connectHelp")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
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
                <Button size="sm" variant="outline" onClick={() => void copySnippet(snippet.value)}>
                  <CopyIcon className="mr-1.5 h-3.5 w-3.5" />
                  {t("copy")}
                </Button>
              </div>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">{t("authNote")}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">{t("allowlist")}</CardTitle>
          <CardDescription>{t("allowlistHelp")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {config.allowlist.map((entry) => (
              <span
                key={entry}
                className="flex items-center gap-1 rounded bg-muted px-2 py-1 text-xs font-mono"
              >
                {entry}
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground"
                  aria-label={`${t("remove")} ${entry}`}
                  onClick={() =>
                    void persist({ allowlist: config.allowlist.filter((e) => e !== entry) })
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Input
              placeholder={t("allowlistPlaceholder")}
              aria-label={t("allowlist")}
              className="font-mono text-xs"
              onChange={(e) => (allowlistDraftRef.current = e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return
                const value = allowlistDraftRef.current.trim()
                if (value && !config.allowlist.includes(value)) {
                  void persist({ allowlist: [...config.allowlist, value] })
                }
                allowlistDraftRef.current = ""
                ;(e.target as HTMLInputElement).value = ""
              }}
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="gw-rate-limit" className="flex-1">
              {t("rateLimit")}
            </Label>
            <Input
              id="gw-rate-limit"
              type="number"
              min={1}
              max={60000}
              className="w-28"
              value={config.rateLimitPerMin}
              onChange={(e) => {
                const next = Math.max(1, Number.parseInt(e.target.value || "0", 10) || 600)
                void persist({ rateLimitPerMin: next })
              }}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">{t("logHeading")}</CardTitle>
          <CardDescription>{t("logHelp")}</CardDescription>
        </CardHeader>
        <CardContent>
          {log.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("logEmpty")}</p>
          ) : (
            <ul className="space-y-1" data-testid="gateway-log">
              {log.map((entry) => (
                <li key={entry.id} className="flex items-center gap-2 text-xs font-mono">
                  <span
                    className={
                      entry.status < 400
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-destructive"
                    }
                  >
                    {entry.status}
                  </span>
                  <span className="truncate">{entry.route}</span>
                  <span className="ml-auto text-muted-foreground">{entry.remoteIp}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

export default GatewaySection
