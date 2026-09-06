"use client"

/**
 * Settings → Connections → Tunnel tab.
 *
 * Surfaces the Cloudflared tunnel state — start / stop, current public
 * URL — alongside per-adapter webhook URL helpers so operators can copy
 * the right callback for each enabled adapter and paste it into the
 * platform admin console (Slack Event Subscriptions, Lark Open Platform
 * webhook callback URL, Telegram webhook URL, etc.).
 *
 * The launcher itself is the same Tauri command set the Connectivity
 * section uses (`companion_tunnel_start` / `companion_tunnel_stop` /
 * `companion_tunnel_current`), and the same one cloudflared child: when
 * that child is already exposing the companion listener, starting here is
 * a conflict the operator resolves explicitly rather than a silent swap.
 * Cloudflared not being installed is surfaced inline with the shared
 * install guide for this OS.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"
import {
  CheckCircle2Icon,
  CopyIcon,
  InfoIcon,
  LoaderIcon,
  PlugIcon,
  PowerIcon,
  PowerOffIcon,
  ShieldAlertIcon,
  XCircleIcon,
} from "lucide-react"
import { TunnelInstallGuide } from "@/components/connectivity/tunnel-install-guide"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { useConnectorControlReach } from "@/components/connectors/connector-host-notice"
import {
  probeTunnel,
  startTunnel,
  stopTunnel,
  getTunnelInfo,
  getTunnelConfig,
  type TunnelInfo,
} from "@/lib/connectivity/tunnel-resolver"
import { getDb } from "@/lib/db/schema"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { CONNECTORS_SERVER_PORT } from "@/lib/connectors/server-transport"
import { refreshCompanionEndpoints } from "@/lib/connectivity/endpoint-refresh"

// The Rust axum connectors server binds plain HTTP on the loopback interface,
// so the tunnel origin must be `http://` on the SAME port the provider starts
// it on (`CONNECTORS_SERVER_PORT`). An `https://` origin against the plain-HTTP
// server fails the TLS handshake (cloudflared → 502).
const DEFAULT_LOCAL_URL = `http://127.0.0.1:${CONNECTORS_SERVER_PORT}`

// Paths MUST match the Rust axum routes (axum_app.rs) and each adapter's own
// config form (`/webhook/<type>/<id>`). The previous `/connectors/...` prefix
// 404'd, so every URL this card surfaced was wrong.
const ADAPTER_WEBHOOK_PATH: Record<string, (id: string) => string | null> = {
  lark: (id) => `/webhook/lark/${id}`,
  slack: (id) => `/webhook/slack/${id}`,
  telegram: (id) => `/webhook/telegram/${id}`,
  "wechat-oa": (id) => `/webhook/wechat-oa/${id}`,
  "qq-official": (id) => `/webhook/qq-official/${id}`,
  // Discord is gateway-only until the adapter starts an Interactions webhook
  // transport and handles Discord PING callbacks.
  discord: () => null,
  // OneBot uses reverse-WS, not webhook — no public URL.
  onebot: () => null,
}

export interface TunnelTabProps {
  /** Override the default local URL the tunnel points at (test). */
  defaultLocalUrl?: string
}

export function TunnelTab({ defaultLocalUrl = DEFAULT_LOCAL_URL }: TunnelTabProps = {}) {
  const t = useTranslations("settings.connections.tunnel")
  // The cloudflared child process is genuinely the desktop's own — but the
  // reason it is unreachable differs by host, and "open Cognia on your
  // desktop" is wrong for a server deployment that does not use a tunnel at
  // all. The block decides which sentence, the gate stays the same.
  const reach = useConnectorControlReach("desktop-shell")
  const desktop = reach.available
  const [info, setInfo] = useState<TunnelInfo | null>(null)
  const [config, setConfig] = useState<{
    mode: "quick" | "named"
    hostname?: string
    hasToken: boolean
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [notInstalled, setNotInstalled] = useState(false)
  const [probing, setProbing] = useState(false)
  const [conflict, setConflict] = useState<TunnelInfo | null>(null)

  // Probe the current tunnel state on mount + every 3 s so the panel
  // reflects external changes (e.g. another window started the tunnel).
  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      try {
        if (!desktop) {
          const companion = await refreshCompanionEndpoints()
          if (!cancelled) {
            setInfo(
              companion?.tunnelBaseUrl
                ? { publicUrl: companion.tunnelBaseUrl, localUrl: defaultLocalUrl }
                : null
            )
            setConfig(null)
          }
          return
        }
        const [current, cfg] = await Promise.all([getTunnelInfo(), getTunnelConfig()])
        if (!cancelled) {
          setInfo(current)
          setConfig(cfg)
        }
      } catch {
        if (!cancelled) {
          setInfo(null)
          setConfig(null)
        }
      }
    }
    void refresh()
    const id = setInterval(() => void refresh(), 3000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [defaultLocalUrl, desktop])

  const recheck = useCallback(async () => {
    setProbing(true)
    try {
      const probe = await probeTunnel()
      if (probe) setNotInstalled(!probe.installed)
    } finally {
      setProbing(false)
    }
  }, [])

  const onStart = async (replace = false) => {
    if (!desktop) {
      toast.error(t("desktopOnly"))
      return
    }
    setBusy(true)
    setNotInstalled(false)
    try {
      const result = await startTunnel(defaultLocalUrl, undefined, { replace })
      if (result.kind === "started") {
        setInfo(result.info)
        setConflict(null)
        toast.success(t("started"))
      } else if (result.kind === "busy") {
        setConflict(result.current)
      } else if (result.kind === "not_installed") {
        setNotInstalled(true)
        toast.error(t("notInstalled"))
      } else if (result.kind === "unsupported") {
        toast.error(t("desktopOnly"))
      } else {
        toast.error(result.message)
      }
    } finally {
      setBusy(false)
    }
  }

  const onStop = async () => {
    if (!desktop) return
    setBusy(true)
    try {
      await stopTunnel()
      setInfo(null)
      setConflict(null)
      toast.success(t("stopped"))
    } finally {
      setBusy(false)
    }
  }

  const adapters = useLiveQuery<AdapterInstanceRow[]>(
    () =>
      typeof window === "undefined" ? Promise.resolve([]) : getDb().adapterInstances.toArray(),
    []
  )

  const copyText = async (text: string, successKey = "copied") => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(t(successKey))
    } catch {
      toast.error(t("copyFailed"))
    }
  }

  return (
    <div className="space-y-4" data-testid="tunnel-tab">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between gap-2 text-sm font-medium">
            <span className="flex items-center gap-2">
              <PlugIcon className="h-4 w-4" aria-hidden />
              {t("title")}
            </span>
            <TunnelStatusBadge running={Boolean(info)} />
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">{t("description")}</p>
          {config?.mode === "named" && config.hostname && (
            <p className="text-[11px] text-muted-foreground">
              {t("modeNamed")}: <span className="font-mono">{config.hostname}</span>
            </p>
          )}
          {info ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <code
                  className="flex-1 rounded-md border bg-muted/40 px-2 py-1.5 text-xs"
                  data-testid="tunnel-public-url"
                >
                  {info.publicUrl}
                </code>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void copyText(info.publicUrl)}
                  data-testid="tunnel-copy-url"
                >
                  <CopyIcon className="mr-1.5 h-3 w-3" aria-hidden />
                  {t("copy")}
                </Button>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void onStop()}
                disabled={busy || !desktop}
                data-testid="tunnel-stop"
              >
                {busy ? (
                  <LoaderIcon className="mr-1.5 h-3 w-3 animate-spin" aria-hidden />
                ) : (
                  <PowerOffIcon className="mr-1.5 h-3 w-3" aria-hidden />
                )}
                {t("stop")}
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              size="sm"
              onClick={() => void onStart(false)}
              disabled={busy || !desktop}
              data-testid="tunnel-start"
            >
              {busy ? (
                <LoaderIcon className="mr-1.5 h-3 w-3 animate-spin" aria-hidden />
              ) : (
                <PowerIcon className="mr-1.5 h-3 w-3" aria-hidden />
              )}
              {t("start")}
            </Button>
          )}
          {info?.localUrl && info.localUrl !== defaultLocalUrl ? (
            <p
              className="text-[11px] text-amber-700 dark:text-amber-300"
              data-testid="tunnel-exposing-other"
            >
              {t("exposingOther", { localUrl: info.localUrl })}
            </p>
          ) : null}
          {notInstalled && (
            <TunnelInstallGuide
              tool="cloudflared"
              onRecheck={recheck}
              rechecking={probing}
              testid="tunnel-install-guide"
            />
          )}
          {conflict && (
            <div
              role="alertdialog"
              aria-label={t("busyTitle")}
              className="space-y-2 rounded-md border border-amber-300 bg-amber-50/40 px-3 py-2 dark:border-amber-800 dark:bg-amber-950/20"
              data-testid="tunnel-conflict"
            >
              <p className="flex items-start gap-2 text-xs font-medium">
                <ShieldAlertIcon className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
                {t("busyTitle")}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {t("busyBody", { localUrl: conflict.localUrl, publicUrl: conflict.publicUrl })}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void onStart(true)}
                  disabled={busy}
                  data-testid="tunnel-conflict-replace"
                >
                  {t("busyReplace")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setConflict(null)}
                  disabled={busy}
                  data-testid="tunnel-conflict-keep"
                >
                  {t("busyKeep")}
                </Button>
              </div>
            </div>
          )}
          {reach.block && (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50/40 px-3 py-2 text-xs text-muted-foreground dark:border-amber-800 dark:bg-amber-950/20">
              <InfoIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span data-testid="tunnel-host-hint">
                {reach.block === "no-runtime" ? t("noRuntimeHint") : t("remoteHostHint")}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <PlugIcon className="h-4 w-4" aria-hidden />
            {t("webhookUrls.title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">{t("webhookUrls.description")}</p>
          {(adapters ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="tunnel-no-adapters">
              {t("webhookUrls.noAdapters")}
            </p>
          ) : (
            <ul className="space-y-2">
              {(adapters ?? []).map((adapter) => {
                const builder = ADAPTER_WEBHOOK_PATH[adapter.type]
                const path =
                  adapter.transportMode === "webhook" && builder ? builder(adapter.id) : null
                const url = path && info?.publicUrl ? `${info.publicUrl}${path}` : null
                return (
                  <li
                    key={adapter.id}
                    className="rounded-md border bg-muted/20 px-3 py-2"
                    data-testid={`tunnel-adapter-row-${adapter.id}`}
                  >
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px]">
                        {adapter.type}
                      </Badge>
                      <span className="text-sm font-medium">{adapter.displayName}</span>
                    </div>
                    {!path ? (
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {t("webhookUrls.notApplicable")}
                      </p>
                    ) : !info?.publicUrl ? (
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {t("webhookUrls.tunnelOff")}
                      </p>
                    ) : (
                      <div className="mt-1 flex items-center gap-2">
                        <code
                          className="flex-1 rounded border bg-background px-2 py-1 text-[11px]"
                          data-testid={`tunnel-adapter-url-${adapter.id}`}
                        >
                          {url}
                        </code>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => void copyText(url!, "copied")}
                          data-testid={`tunnel-adapter-copy-${adapter.id}`}
                          aria-label={t("webhookUrls.copy", { name: adapter.displayName })}
                        >
                          <CopyIcon className="h-3 w-3" aria-hidden />
                        </Button>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function TunnelStatusBadge({ running }: { running: boolean }) {
  const t = useTranslations("settings.connections.tunnel")
  return (
    <Badge
      variant="outline"
      className={running ? "border-green-400 text-green-700 dark:text-green-300" : ""}
      data-testid="tunnel-status-badge"
    >
      {running ? (
        <CheckCircle2Icon className="mr-1 h-3 w-3" aria-hidden />
      ) : (
        <XCircleIcon className="mr-1 h-3 w-3" aria-hidden />
      )}
      {running ? t("status.running") : t("status.off")}
    </Badge>
  )
}
