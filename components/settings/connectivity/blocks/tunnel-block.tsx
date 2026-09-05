"use client"

/**
 * Cloud & relay → cloudflared tunnel. Was `TunnelCard` in the retired
 * companion section. The tunnel is a child process of the desktop app, so
 * from any other shell the block says so instead of vanishing.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, CloudIcon } from "lucide-react"
import { toast } from "sonner"

import { SettingsBlock, SettingsField } from "@/components/settings/common/settings-block"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Switch } from "@/components/ui/switch"
import { useHostAdminReachForCommand } from "@/hooks/connectivity/use-host-admin-reach"
import { saveNamedTunnelConfig } from "@/lib/connectivity/tunnel-resolver"

import {
  DEFAULT_PORT,
  clearNamedTunnelConfig,
  getTunnelConfig,
  getTunnelInfo,
  setTunnelMode,
  startTunnel,
  stopTunnel,
  transportInvoker,
  type TunnelConfig,
  type TunnelInfo,
} from "./companion-server-commands"
import { HostReachNotice } from "./host-reach-notice"

export function TunnelBlock() {
  const t = useTranslations("mobile.companion.tunnel")
  const reach = useHostAdminReachForCommand("companion_tunnel_start")
  const desktop = reach.available
  const [info, setInfo] = useState<TunnelInfo | null>(null)
  const [config, setConfig] = useState<TunnelConfig | null>(null)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [hostnameInput, setHostnameInput] = useState("")
  const [tokenInput, setTokenInput] = useState("")

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
    return () => {
      cancelled = true
    }
  }, [desktop])

  const onToggle = useCallback(
    async (enabled: boolean) => {
      if (!desktop) return
      setBusy(true)
      try {
        if (enabled) {
          const next = await startTunnel(`https://127.0.0.1:${DEFAULT_PORT}`)
          setInfo(next)
          toast.success(t("started"))
        } else {
          await stopTunnel()
          setInfo(null)
          toast.success(t("stopped"))
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toast.error(/cloudflared.*not.found|not.installed/i.test(msg) ? t("notInstalled") : msg)
      } finally {
        setBusy(false)
      }
    },
    [desktop, t]
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

  return (
    <SettingsBlock
      icon={<CloudIcon />}
      title={t("title")}
      description={t("description")}
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
    >
      {reach.block ? <HostReachNotice block={reach.block} testid="tunnel-reach" /> : null}
      <p className="break-all font-mono text-xs text-muted-foreground" data-testid="tunnel-url">
        {publicUrl ?? t("off")}
      </p>
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
