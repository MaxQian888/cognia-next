"use client"

/**
 * Local host → mDNS advertisement. Was `MdnsCard` in the retired companion
 * section: the switch shows what is running, the saved boot preference is read
 * beside it, and the two disagreeing is the one state worth a warning.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { RadioIcon, ShieldAlertIcon } from "lucide-react"
import { toast } from "sonner"

import { SettingsBlock } from "@/components/settings/common/settings-block"
import { Switch } from "@/components/ui/switch"
import { useHostAdminReachForCommand } from "@/hooks/connectivity/use-host-admin-reach"
import { APP_VERSION } from "@/lib/app-version"
import { startBroadcast, stopBroadcast } from "@/lib/connectivity/mdns-discovery"
import {
  loadReachabilityPrefs,
  patchReachabilityPrefs,
} from "@/lib/connectivity/reachability-prefs"
import { transport } from "@/lib/tauri"

import { DEFAULT_PORT, getMdnsStatus, transportInvoker } from "./companion-server-commands"
import { HostReachNotice } from "./host-reach-notice"

export function MdnsBlock() {
  const t = useTranslations("mobile.companion.mdns")
  const reach = useHostAdminReachForCommand("companion_mdns_start")
  const desktop = reach.available
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [wanted, setWanted] = useState<boolean | null>(null)

  useEffect(() => {
    if (!desktop) return
    let cancelled = false
    void getMdnsStatus()
      .then((s) => {
        if (!cancelled) setRunning(s)
      })
      .catch(() => {})
    void loadReachabilityPrefs()
      .then((prefs) => {
        if (!cancelled) setWanted(prefs.mdnsEnabled)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [desktop])
  const autostartFailed = wanted === true && !running && !busy

  const onToggle = useCallback(
    async (enabled: boolean) => {
      if (!desktop) return
      setBusy(true)
      try {
        if (enabled) {
          const fingerprint = await transport
            .call<string>("companion_get_tls_fingerprint")
            .catch(() => "")
          const started = await startBroadcast(
            { port: DEFAULT_PORT, appVersion: APP_VERSION, tlsFingerprint: fingerprint },
            transportInvoker
          )
          if (started.kind === "error") throw new Error(started.message)
          if (started.kind === "unsupported") throw new Error(t("onlyDesktop"))
          setRunning(true)
          setWanted(true)
          toast.success(t("started"))
        } else {
          await stopBroadcast(transportInvoker)
          setRunning(false)
          setWanted(false)
          toast.success(t("stopped"))
        }
        // Remember the choice so the boot restore re-advertises. Without this
        // the broadcast dies with the process and the phone that paired over
        // the LAN silently loses discovery on the next restart.
        await patchReachabilityPrefs({ mdnsEnabled: enabled })
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [desktop, t]
  )

  return (
    <SettingsBlock
      icon={<RadioIcon />}
      title={t("title")}
      description={t("description")}
      action={
        <Switch
          checked={running}
          onCheckedChange={onToggle}
          disabled={!desktop || busy}
          aria-label={t("enableLabel")}
        />
      }
      testid="mdns-block"
      settingId="companion-mdns"
      contentClassName="space-y-3"
    >
      {reach.block ? <HostReachNotice block={reach.block} testid="mdns-reach" /> : null}
      {autostartFailed ? (
        <p
          role="status"
          className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300"
          data-testid="mdns-autostart-failed"
        >
          <ShieldAlertIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          <span>{t("autostartFailed")}</span>
        </p>
      ) : null}
    </SettingsBlock>
  )
}
