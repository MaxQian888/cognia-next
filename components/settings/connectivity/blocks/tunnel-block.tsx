"use client"

/**
 * Cloud & relay → cloudflared tunnel. Was `TunnelCard` in the retired
 * companion section. The tunnel is a child process of the desktop app, so
 * from any other shell the block says so instead of vanishing.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, CloudIcon, LoaderIcon, ShieldAlertIcon } from "lucide-react"
import { toast } from "sonner"

import { TunnelInstallGuide } from "@/components/connectivity/tunnel-install-guide"
import { SettingsBlock, SettingsField } from "@/components/settings/common/settings-block"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Switch } from "@/components/ui/switch"
import { useHostAdminReachForCommand } from "@/hooks/connectivity/use-host-admin-reach"
import { cn } from "@/lib/utils"
import {
  COMPANION_TUNNEL_LOCAL_URL,
  probeTunnel,
  saveNamedTunnelConfig,
  startTunnel,
  type TunnelProbe,
} from "@/lib/connectivity/tunnel-resolver"

import {
  clearNamedTunnelConfig,
  getTunnelConfig,
  getTunnelInfo,
  setTunnelMode,
  stopTunnel,
  transportInvoker,
  type TunnelConfig,
  type TunnelInfo,
} from "./companion-server-commands"
import { HostReachNotice } from "./host-reach-notice"

export function TunnelBlock() {
  const t = useTranslations("mobile.companion.tunnel")
  const tc = useTranslations("settings.connectivity.tunnel")
  const reach = useHostAdminReachForCommand("companion_tunnel_start")
  const desktop = reach.available
  const [info, setInfo] = useState<TunnelInfo | null>(null)
  const [config, setConfig] = useState<TunnelConfig | null>(null)
  const [probe, setProbe] = useState<TunnelProbe | null>(null)
  const [probing, setProbing] = useState(false)
  // The one cloudflared child is shared with the Connections tunnel tab, so
  // both taking it over and shutting it down need the user's word first.
  // `open` is separate from the payload so the dialog keeps the host and the
  // intent it asked about on screen while it animates out.
  const [conflict, setConflict] = useState<{
    current: TunnelInfo
    intent: "start" | "stop"
    open: boolean
  } | null>(null)
  const closeConflict = useCallback(
    () => setConflict((prev) => (prev ? { ...prev, open: false } : prev)),
    []
  )
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [hostnameInput, setHostnameInput] = useState("")
  const [tokenInput, setTokenInput] = useState("")
  // The conflict dialog opens from an async answer, not from a Trigger, so
  // Radix has nothing to hand focus back to; the switch that asked gets it.
  const switchRef = useRef<HTMLButtonElement>(null)

  const runProbe = useCallback(async () => {
    if (!desktop) return
    setProbing(true)
    try {
      // `null` is "unknown", not "missing": the switch stays usable and the
      // launcher's own error is the authority.
      setProbe(await probeTunnel(transportInvoker))
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
    // Written from a promise callback, never synchronously: the effect
    // set-state rule is what keeps this honest, so this does not call
    // `runProbe` (which flips `probing` on the spot for the button).
    void probeTunnel(transportInvoker)
      .then((next) => {
        if (!cancelled) setProbe(next)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [desktop])

  const mode = config?.mode ?? "quick"
  // A live quick tunnel started elsewhere (the Connections tab exposes the
  // webhook receiver through the same child) shows as on, with what it is
  // actually exposing, rather than as this listener's tunnel. Every path that
  // would take that child away from the other surface asks first.
  const exposingOther = Boolean(
    info && mode === "quick" && info.localUrl && info.localUrl !== COMPANION_TUNNEL_LOCAL_URL
  )

  const start = useCallback(
    async (replace: boolean) => {
      setBusy(true)
      try {
        const outcome = await startTunnel(COMPANION_TUNNEL_LOCAL_URL, transportInvoker, {
          replace,
        })
        switch (outcome.kind) {
          case "started":
            setInfo(outcome.info)
            closeConflict()
            toast.success(t("started"))
            break
          case "busy":
            // The child is serving another origin. Show the conflict and let
            // the user decide, instead of the old silent swap.
            setConflict({ current: outcome.current, intent: "start", open: true })
            break
          case "not_installed":
            setProbe({ installed: false })
            toast.error(t("notInstalled"))
            break
          case "error":
            toast.error(outcome.message)
            break
          case "unsupported":
            // No launcher on this shell; `HostReachNotice` already says why.
            break
        }
      } finally {
        setBusy(false)
      }
    },
    [closeConflict, t]
  )

  const stop = useCallback(async () => {
    setBusy(true)
    try {
      await stopTunnel()
      setInfo(null)
      closeConflict()
      toast.success(t("stopped"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [closeConflict, t])

  const onToggle = useCallback(
    async (enabled: boolean) => {
      if (!desktop) return
      if (enabled) {
        await start(false)
        return
      }
      if (exposingOther && info) {
        // Stopping would take down a public URL another surface is showing.
        // The same conflict `TunnelError::Busy` refuses on the way in.
        setConflict({ current: info, intent: "stop", open: true })
        return
      }
      await stop()
    },
    [desktop, exposingOther, info, start, stop]
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
        // Only tear down a tunnel this block owns: the same child may be
        // serving the connectors' webhook receiver.
        if (mode === "quick" && !exposingOther) {
          await stopTunnel()
          setInfo(null)
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [desktop, exposingOther]
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

  const namedReady = Boolean(config?.hasToken && config?.hostname)
  const publicUrl = info ? info.publicUrl : namedReady ? config?.hostname : null
  const notInstalled = desktop && probe !== null && !probe.installed

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
          ref={switchRef}
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
      {/*
        Taking over or stopping the one shared cloudflared child changes a
        public URL another surface is showing, so it is a modal decision. It
        stays open while the chosen action runs and closes once it lands; a
        second refusal re-renders it with the host that refused.
      */}
      <AlertDialog
        open={conflict?.open === true}
        onOpenChange={(next) => {
          if (next || busy || !conflict?.open) return
          closeConflict()
          toast.success(tc("busyCancelled"))
        }}
      >
        <AlertDialogContent
          data-testid="tunnel-conflict"
          data-intent={conflict?.intent}
          aria-busy={busy}
          onCloseAutoFocus={(event) => {
            const target = switchRef.current
            if (target?.isConnected) {
              event.preventDefault()
              target.focus()
            }
          }}
        >
          {conflict ? (
            <>
              <AlertDialogHeader>
                <AlertDialogMedia className="bg-amber-500/10 text-amber-700 dark:text-amber-300">
                  <ShieldAlertIcon aria-hidden="true" />
                </AlertDialogMedia>
                <AlertDialogTitle>{tc("busyTitle")}</AlertDialogTitle>
                <AlertDialogDescription className="wrap-anywhere">
                  {conflict.intent === "stop"
                    ? tc("busyStopBody", {
                        localUrl: conflict.current.localUrl,
                        publicUrl: conflict.current.publicUrl,
                      })
                    : tc("busyBody", {
                        localUrl: conflict.current.localUrl,
                        publicUrl: conflict.current.publicUrl,
                      })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={busy} data-testid="tunnel-conflict-keep">
                  {tc("busyKeep")}
                </AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  disabled={busy}
                  onClick={(event) => {
                    // Stay open while it runs: success clears the conflict,
                    // a failure leaves the question standing.
                    event.preventDefault()
                    void (conflict.intent === "stop" ? stop() : start(true))
                  }}
                  data-testid="tunnel-conflict-replace"
                >
                  {busy ? <LoaderIcon className="animate-spin" aria-hidden="true" /> : null}
                  {conflict.intent === "stop" ? tc("busyStopConfirm") : tc("busyReplace")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          ) : null}
        </AlertDialogContent>
      </AlertDialog>
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
