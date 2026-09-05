"use client"

/**
 * Local host → the companion server: master switch, bind mode, TLS material.
 *
 * Was `ServerStatusCard` in the retired companion section. Two things moved
 * with it unchanged: the radio is the DESIRED binding and is persisted before
 * the running check, and the boot preference is only written from the switch,
 * never from an internal start.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { CircleIcon, ServerIcon, ShieldAlertIcon } from "lucide-react"
import { toast } from "sonner"

import { SettingsBlock } from "@/components/settings/common/settings-block"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Switch } from "@/components/ui/switch"
import { useHostAdminReachForCommand } from "@/hooks/connectivity/use-host-admin-reach"
import {
  loadReachabilityPrefs,
  patchReachabilityPrefs,
} from "@/lib/connectivity/reachability-prefs"
import { transport } from "@/lib/tauri"
import { cn } from "@/lib/utils"

import {
  fetchServerStatus,
  startServer,
  stopServer,
  type BindMode,
  type CompanionServerStatus,
  type CompanionTlsPaths,
} from "./companion-server-commands"
import { HostReachNotice } from "./host-reach-notice"

const STATUS_POLL_MS = 3000

export function ServerBlock() {
  const t = useTranslations("mobile.companion.server")
  const reach = useHostAdminReachForCommand("companion_server_start")
  const desktop = reach.available
  const [status, setStatus] = useState<CompanionServerStatus>({
    running: false,
    bindMode: "none",
    boundPort: null,
  })
  const [desiredBind, setDesiredBind] = useState<BindMode>("loopback")
  const [busy, setBusy] = useState(false)
  // The saved boot preference, next to the live status. The switch shows what
  // is running, this is what was asked for, and the two disagree exactly when
  // the boot restore failed.
  const [wanted, setWanted] = useState<boolean | null>(null)
  const [tlsPaths, setTlsPaths] = useState<CompanionTlsPaths | null>(null)

  useEffect(() => {
    if (!desktop) return
    let cancelled = false
    void loadReachabilityPrefs()
      .then((prefs) => {
        if (!cancelled) setWanted(prefs.serverEnabled)
      })
      .catch(() => {})
    void transport
      .call<CompanionTlsPaths>("companion_tls_paths")
      .then((paths) => {
        if (!cancelled && paths && typeof paths.certPemPath === "string") setTlsPaths(paths)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [desktop])

  useEffect(() => {
    if (!desktop) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      try {
        const next = await fetchServerStatus()
        if (!cancelled) {
          setStatus(next)
          if (next.bindMode === "loopback" || next.bindMode === "lan") setDesiredBind(next.bindMode)
        }
      } catch {
        // The host is not answering yet. The next tick asks again.
      }
      if (!cancelled) timer = setTimeout(refresh, STATUS_POLL_MS)
    }
    void refresh()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [desktop])

  const onToggleEnabled = useCallback(
    async (enabled: boolean) => {
      if (!desktop) return
      setBusy(true)
      try {
        if (enabled) {
          const port = await startServer(desiredBind)
          setStatus({ running: true, bindMode: desiredBind, boundPort: port })
          setWanted(true)
          toast.success(t("started", { port }))
          await patchReachabilityPrefs({
            serverEnabled: true,
            port,
            bindLoopbackOnly: desiredBind === "loopback",
          })
        } else {
          await stopServer()
          setStatus({ running: false, bindMode: "none", boundPort: null })
          setWanted(false)
          toast.success(t("stopped"))
          await patchReachabilityPrefs({ serverEnabled: false })
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [desktop, desiredBind, t]
  )

  const onBindModeChange = useCallback(
    async (next: string) => {
      const mode = next as BindMode
      setDesiredBind(mode)
      if (!desktop) return
      await patchReachabilityPrefs({ bindLoopbackOnly: mode === "loopback" })
      if (!status.running) return
      setBusy(true)
      try {
        await stopServer()
        const port = await startServer(mode)
        setStatus({ running: true, bindMode: mode, boundPort: port })
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [desktop, status.running]
  )

  const lanWarning = status.running && status.bindMode === "lan"
  const autostartFailed = wanted === true && !status.running && !busy

  return (
    <SettingsBlock
      icon={<ServerIcon />}
      title={t("title")}
      description={
        status.running && status.boundPort !== null
          ? t("listeningOn", {
              url: `http://${
                status.bindMode === "lan" ? t("bindModePlaceholderLan") : "127.0.0.1"
              }:${status.boundPort}`,
            })
          : t("serverOff")
      }
      badge={<StatusBadge status={status} desktop={desktop} t={t} />}
      action={
        <Switch
          checked={status.running}
          onCheckedChange={onToggleEnabled}
          disabled={!desktop || busy}
          aria-label={t("enableLabel")}
        />
      }
      testid="server-block"
      settingId="companion-server"
    >
      {reach.block ? <HostReachNotice block={reach.block} testid="server-reach" /> : null}
      <div>
        <Label className="mb-2 block text-xs text-muted-foreground">{t("bindMode")}</Label>
        <RadioGroup
          value={desiredBind}
          onValueChange={onBindModeChange}
          className="space-y-2"
          aria-label={t("bindMode")}
        >
          <BindOption
            value="loopback"
            id="bind-loopback"
            label={t("loopbackLabel")}
            description={t("loopbackDesc")}
            disabled={!desktop || busy}
          />
          <BindOption
            value="lan"
            id="bind-lan"
            label={t("lanLabel")}
            description={t("lanDesc")}
            disabled={!desktop || busy}
          />
        </RadioGroup>
      </div>
      {lanWarning ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-control bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300"
        >
          <ShieldAlertIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          <span>{t("httpsWarning")}</span>
        </p>
      ) : null}
      {autostartFailed ? (
        <p
          role="status"
          className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300"
          data-testid="server-autostart-failed"
        >
          <ShieldAlertIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          <span>{t("autostartFailed")}</span>
        </p>
      ) : null}
      {tlsPaths ? (
        <dl className="space-y-1 text-xs text-muted-foreground" data-testid="server-tls-paths">
          <div className="flex flex-col gap-0.5">
            <dt>{t("certificateFile")}</dt>
            <dd className="break-all font-mono text-[11px] text-foreground/80">
              {tlsPaths.certPemPath}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt>{t("certificateFingerprint")}</dt>
            <dd className="break-all font-mono text-[11px] text-foreground/80">
              {tlsPaths.fingerprintSha256}
            </dd>
          </div>
        </dl>
      ) : null}
    </SettingsBlock>
  )
}

function BindOption({
  value,
  id,
  label,
  description,
  disabled,
}: {
  value: BindMode
  id: string
  label: string
  description: string
  disabled: boolean
}) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-border/60 px-3 py-2">
      <RadioGroupItem value={value} id={id} disabled={disabled} className="mt-0.5" />
      <div className="space-y-0.5">
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
        </Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}

function StatusBadge({
  status,
  desktop,
  t,
}: {
  status: CompanionServerStatus
  desktop: boolean
  t: (key: string) => string
}) {
  if (!desktop) {
    return (
      <span className="text-[10px] uppercase text-muted-foreground" title={t("desktopOnly")}>
        {t("statusWeb")}
      </span>
    )
  }
  return (
    <span
      className={cn(
        "flex items-center gap-1 text-[10px] uppercase",
        status.running ? "text-emerald-500" : "text-muted-foreground"
      )}
    >
      <CircleIcon className="size-2 fill-current" aria-hidden="true" />
      {status.running ? t("statusLive") : t("statusIdle")}
    </span>
  )
}
