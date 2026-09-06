"use client"

/**
 * Cloud & relay → cloudflared tunnel. Was `TunnelCard` in the retired
 * companion section. The tunnel is a child process of the desktop app, so
 * from any other shell the block says so instead of vanishing.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, CloudIcon, ShieldAlertIcon } from "lucide-react"
import { toast } from "sonner"

import { TunnelInstallGuide } from "@/components/connectivity/tunnel-install-guide"
import { SettingsBlock, SettingsField } from "@/components/settings/common/settings-block"
import { Surface } from "@/components/surface/surface"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Switch } from "@/components/ui/switch"
import { useHostAdminReachForCommand } from "@/hooks/connectivity/use-host-admin-reach"
import { cn } from "@/lib/utils"
import {
  parseTunnelBusy,
  saveNamedTunnelConfig,
  type TunnelProbe,
} from "@/lib/connectivity/tunnel-resolver"

import {
  DEFAULT_PORT,
  clearNamedTunnelConfig,
  getTunnelConfig,
  getTunnelInfo,
  probeTunnel,
  setTunnelMode,
  startTunnel,
  stopTunnel,
  transportInvoker,
  type TunnelConfig,
  type TunnelInfo,
} from "./companion-server-commands"
import { HostReachNotice } from "./host-reach-notice"

/** The origin this block exposes: the companion HTTPS listener. */
export const COMPANION_TUNNEL_LOCAL_URL = `https://127.0.0.1:${DEFAULT_PORT}`

export function TunnelBlock() {
  const t = useTranslations("mobile.companion.tunnel")
  const tc = useTranslations("settings.connectivity.tunnel")
  const reach = useHostAdminReachForCommand("companion_tunnel_start")
  const desktop = reach.available
  const [info, setInfo] = useState<TunnelInfo | null>(null)
  const [config, setConfig] = useState<TunnelConfig | null>(null)
  const [probe, setProbe] = useState<TunnelProbe | null>(null)
  const [probing, setProbing] = useState(false)
  const [conflict, setConflict] = useState<TunnelInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [hostnameInput, setHostnameInput] = useState("")
  const [tokenInput, setTokenInput] = useState("")

  const runProbe = useCallback(async () => {
    if (!desktop) return
    setProbing(true)
    try {
      setProbe(await probeTunnel())
    } catch {
      // "Unknown" rather than "missing": the switch stays usable and the
      // launcher's own error is the authority.
      setProbe(null)
    } finally {
      setProbing(false)
    }
  }, [desktop])

  useEffect(() => {
    if (!desktop) return
    let cancelled = false
    void Promise.all([getTunnelInfo(), getTunnelConfig()])
      .then(([current, cfg]) => {
        if (cancelled) return
        setInfo(current)
        setConfig(cfg)
        if (cfg?.hostname) setHostnameInput(cfg.hostname)
      })
      .catch(() => {})
    void probeTunnel()
      .then((next) => {
        if (!cancelled) setProbe(next)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [desktop])

  const start = useCallback(
    async (replace: boolean) => {
      setBusy(true)
      try {
        const next = await startTunnel(COMPANION_TUNNEL_LOCAL_URL, replace)
        setInfo(next)
        setConflict(null)
        toast.success(t("started"))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const current = parseTunnelBusy(msg)
        if (current) {
          // The one cloudflared child is serving another origin. Show the
          // conflict and let the user decide, instead of the old silent swap.
          setConflict(current)
          return
        }
        if (/cloudflared.*not.found|not.installed/i.test(msg)) {
          setProbe({ installed: false })
          toast.error(t("notInstalled"))
          return
        }
        toast.error(msg)
      } finally {
        setBusy(false)
      }
    },
    [t]
  )

  const onToggle = useCallback(
    async (enabled: boolean) => {
      if (!desktop) return
      if (enabled) {
        await start(false)
        return
      }
      setBusy(true)
      try {
        await stopTunnel()
        setInfo(null)
        setConflict(null)
        toast.success(t("stopped"))
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [desktop, start, t]
  )

  const onModeChange = useCallback(
    async (mode: "quick" | "named") => {
      if (!desktop) return
      setBusy(true)
      try {
        await setTunnelMode(mode)
        const next = await getTunnelConfig()
        setConfig(next)
        if (next?.hostname) setHostnameInput(next.hostname)
        if (mode === "quick") {
          await stopTunnel()
          setInfo(null)
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [desktop]
  )

  const onSaveNamed = useCallback(async () => {
    if (!desktop || !hostnameInput.trim() || !tokenInput.trim()) return
    setSaving(true)
    try {
      const saved = await saveNamedTunnelConfig(
        tokenInput.trim(),
        hostnameInput.trim(),
        transportInvoker
      )
      if (saved.kind === "error") throw new Error(saved.message)
      setConfig(await getTunnelConfig())
      // The token is a write-only secret and is never read back. Clearing the
      // field on success keeps the badge, driven by `hasToken`, as the truth.
      setTokenInput("")
      toast.success(t("saved"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [desktop, hostnameInput, tokenInput, t])

  const onClearNamed = useCallback(async () => {
    if (!desktop) return
    setBusy(true)
    try {
      await clearNamedTunnelConfig()
      setConfig(await getTunnelConfig())
      setHostnameInput("")
      setTokenInput("")
      setInfo(null)
      toast.success(t("cleared"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [desktop, t])

  const mode = config?.mode ?? "quick"
  const namedReady = Boolean(config?.hasToken && config?.hostname)
  const publicUrl = info ? info.publicUrl : namedReady ? config?.hostname : null
  const notInstalled = desktop && probe !== null && !probe.installed
  // A live quick tunnel started elsewhere (the Connections tab exposes the
  // webhook receiver through the same child) shows as on, with what it is
  // actually exposing, rather than as this listener's tunnel.
  const exposingOther = Boolean(
    info && mode === "quick" && info.localUrl && info.localUrl !== COMPANION_TUNNEL_LOCAL_URL
  )

  return (
    <SettingsBlock
      icon={<CloudIcon />}
      title={t("title")}
      description={t("description")}
      badge={
        desktop && probe?.installed ? (
          <Badge variant="outline" className="text-[10px]" data-testid="tunnel-probe">
            {probe.version
              ? tc("installed", { version: probe.version, path: probe.path ?? "" })
              : tc("installedNoVersion", { path: probe.path ?? "" })}
          </Badge>
        ) : null
      }
      action={
        <Switch
          checked={!!info}
          onCheckedChange={onToggle}
          disabled={!desktop || busy || (mode === "named" && !namedReady)}
          aria-label={t("enableLabel")}
        />
      }
      testid="tunnel-block"
      settingId="companion-tunnel"
      attributes={{ "data-exposing": info?.localUrl }}
    >
      {reach.block ? <HostReachNotice block={reach.block} testid="tunnel-reach" /> : null}
      <p className="break-all font-mono text-xs text-muted-foreground" data-testid="tunnel-url">
        {publicUrl ?? t("off")}
      </p>
      {info?.localUrl ? (
        <p
          className={cn(
            "text-[11px]",
            exposingOther ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"
          )}
          data-testid="tunnel-exposing"
        >
          {exposingOther
            ? tc("exposingOther", { localUrl: info.localUrl })
            : tc("exposing", { localUrl: info.localUrl })}
        </p>
      ) : null}
      {notInstalled ? (
        <TunnelInstallGuide
          tool="cloudflared"
          onRecheck={runProbe}
          rechecking={probing}
          testid="tunnel-install-guide"
        />
      ) : null}
      {conflict ? (
        <Surface asChild layer="base" radius="control">
          <div
            role="alertdialog"
            aria-label={tc("busyTitle")}
            className="space-y-2 border border-amber-300/70 px-3 py-2.5 dark:border-amber-800"
            data-testid="tunnel-conflict"
          >
            <p className="flex items-start gap-2 text-xs font-medium">
              <ShieldAlertIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
              {tc("busyTitle")}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {tc("busyBody", { localUrl: conflict.localUrl, publicUrl: conflict.publicUrl })}
            </p>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => void start(true)}
                disabled={busy}
                data-testid="tunnel-conflict-replace"
              >
                {tc("busyReplace")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setConflict(null)
                  toast.success(tc("busyCancelled"))
                }}
                disabled={busy}
                data-testid="tunnel-conflict-keep"
              >
                {t("clearButton")}
              </Button>
            </div>
          </div>
        </Surface>
      ) : null}
      <RadioGroup
        value={mode}
        onValueChange={(v) => void onModeChange(v as "quick" | "named")}
        className="flex flex-wrap gap-4"
        disabled={!desktop || busy}
      >
        <div className="flex items-center gap-2">
          <RadioGroupItem value="quick" id="tunnel-mode-quick" disabled={!desktop || busy} />
          <Label htmlFor="tunnel-mode-quick" className="text-xs font-normal">
            {t("modeQuick")}
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem value="named" id="tunnel-mode-named" disabled={!desktop || busy} />
          <Label htmlFor="tunnel-mode-named" className="text-xs font-normal">
            {t("modeNamed")}
          </Label>
        </div>
      </RadioGroup>

      {mode === "named" ? (
        <div className="space-y-3">
          <SettingsField htmlFor="tunnel-hostname" label={t("hostnameLabel")} stacked>
            <Input
              id="tunnel-hostname"
              type="url"
              placeholder={t("hostnamePlaceholder")}
              value={hostnameInput}
              onChange={(e) => setHostnameInput(e.target.value)}
              disabled={!desktop || saving}
              className="h-8 text-xs"
            />
          </SettingsField>
          <SettingsField htmlFor="tunnel-token" label={t("tokenLabel")} stacked>
            <Input
              id="tunnel-token"
              type="password"
              placeholder={t("tokenPlaceholder")}
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              disabled={!desktop || saving}
              className="h-8 text-xs"
            />
          </SettingsField>
          {namedReady ? (
            <Badge
              variant="outline"
              className="w-fit gap-1 text-[10px] uppercase text-emerald-600 dark:text-emerald-400"
              data-testid="tunnel-token-configured"
            >
              <CheckIcon className="size-3" aria-hidden="true" />
              {t("tokenConfigured")}
            </Badge>
          ) : null}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => void onSaveNamed()}
              disabled={!desktop || saving || !hostnameInput.trim() || !tokenInput.trim()}
            >
              {saving ? t("saving") : t("saveButton")}
            </Button>
            {namedReady ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void onClearNamed()}
                disabled={busy || saving}
                aria-label={t("clearAria")}
              >
                {t("clearButton")}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </SettingsBlock>
  )
}
