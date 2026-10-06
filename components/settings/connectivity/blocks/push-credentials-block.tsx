"use client"

/**
 * Push → APNs / FCM / HMS credentials. Was `PushCredentialsCard` in the retired
 * companion section. Reaches the Host over `host-admin` since ADR-0170, so a
 * browser configuring a headless server installs the same credentials the
 * desktop renderer does.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { BellIcon } from "lucide-react"
import { toast } from "sonner"

import { SettingsBlock } from "@/components/settings/common/settings-block"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useHostAdminReachForCommand } from "@/hooks/connectivity/use-host-admin-reach"
import { transport } from "@/lib/tauri"

import { HostReachNotice } from "./host-reach-notice"

/** Mirror of the Rust `PushConfigStatus` (`companion_api/commands.rs`). */
export interface PushConfigStatus {
  fcmConfigured: boolean
  apnsConfigured: boolean
  /** Omitted by Hosts that predate Huawei push support. */
  hmsConfigured?: boolean
}

export interface PushCredentialsBlockProps {
  /** Reports the configured state upward, for the panel's test action. */
  onStatus?: (status: PushConfigStatus) => void
}

async function fetchPushStatus(): Promise<PushConfigStatus> {
  return transport.call<PushConfigStatus>("companion_push_status")
}

export function PushCredentialsBlock({ onStatus }: PushCredentialsBlockProps) {
  const t = useTranslations("mobile.companion.push")
  const reach = useHostAdminReachForCommand("companion_push_status")
  const fcmReach = useHostAdminReachForCommand("companion_push_configure_fcm")
  const fcmClearReach = useHostAdminReachForCommand("companion_push_clear_fcm")
  const apnsReach = useHostAdminReachForCommand("companion_push_configure_apns")
  const apnsClearReach = useHostAdminReachForCommand("companion_push_clear_apns")
  const hmsReach = useHostAdminReachForCommand("companion_push_configure_hms")
  const hmsClearReach = useHostAdminReachForCommand("companion_push_clear_hms")
  const available = reach.available
  const [status, setStatus] = useState<PushConfigStatus | null>(null)
  const [statusFailed, setStatusFailed] = useState(false)
  const [statusLoading, setStatusLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [fcmJson, setFcmJson] = useState("")
  const [hms, setHms] = useState({ appId: "", clientSecret: "" })
  const [apns, setApns] = useState({
    keyId: "",
    teamId: "",
    bundleId: "com.cognia.mobile",
    privateKeyPem: "",
    production: false,
  })

  const publish = useCallback(
    (next: PushConfigStatus) => {
      setStatus(next)
      onStatus?.(next)
    },
    [onStatus]
  )

  const refresh = useCallback(async () => {
    if (!available) return
    setStatusLoading(true)
    try {
      publish(await fetchPushStatus())
      setStatusFailed(false)
    } catch (err) {
      setStatusFailed(true)
      toast.error(t("statusFailed", { message: err instanceof Error ? err.message : String(err) }))
    } finally {
      setStatusLoading(false)
    }
  }, [available, publish, t])

  useEffect(() => {
    if (!available) return
    let cancelled = false
    void fetchPushStatus()
      .then((s) => {
        if (!cancelled) {
          publish(s)
          setStatusFailed(false)
        }
      })
      .catch(() => {
        if (!cancelled) setStatusFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [available, publish])

  const onSubmitFcm = useCallback(async () => {
    if (!fcmJson.trim()) {
      toast.error(t("fcmRequired"))
      return
    }
    setBusy(true)
    try {
      await transport.call<void>("companion_push_configure_fcm", {
        serviceAccountJson: fcmJson.trim(),
      })
      setFcmJson("")
      toast.success(t("fcmConfigured"))
      await refresh()
    } catch (err) {
      toast.error(
        t("fcmConfigureFailed", { message: err instanceof Error ? err.message : String(err) })
      )
    } finally {
      setBusy(false)
    }
  }, [fcmJson, refresh, t])

  const onClearFcm = useCallback(async () => {
    setBusy(true)
    try {
      await transport.call<void>("companion_push_clear_fcm")
      toast.success(t("fcmCleared"))
      await refresh()
    } catch (err) {
      toast.error(
        t("fcmClearFailed", { message: err instanceof Error ? err.message : String(err) })
      )
    } finally {
      setBusy(false)
    }
  }, [refresh, t])

  const onSubmitApns = useCallback(async () => {
    const required = ["keyId", "teamId", "bundleId", "privateKeyPem"] as const
    for (const field of required) {
      if (!apns[field].trim()) {
        toast.error(t("apnsFieldRequired", { field }))
        return
      }
    }
    setBusy(true)
    try {
      await transport.call<void>("companion_push_configure_apns", apns)
      toast.success(t("apnsConfigured"))
      setApns((prev) => ({ ...prev, privateKeyPem: "" }))
      await refresh()
    } catch (err) {
      toast.error(
        t("apnsConfigureFailed", { message: err instanceof Error ? err.message : String(err) })
      )
    } finally {
      setBusy(false)
    }
  }, [apns, refresh, t])

  const onClearApns = useCallback(async () => {
    setBusy(true)
    try {
      await transport.call<void>("companion_push_clear_apns")
      toast.success(t("apnsCleared"))
      await refresh()
    } catch (err) {
      toast.error(
        t("apnsClearFailed", { message: err instanceof Error ? err.message : String(err) })
      )
    } finally {
      setBusy(false)
    }
  }, [refresh, t])

  const onSubmitHms = useCallback(async () => {
    if (!hms.appId.trim()) {
      toast.error(t("hmsAppIdRequired"))
      return
    }
    if (!hms.clientSecret.trim()) {
      toast.error(t("hmsClientSecretRequired"))
      return
    }
    setBusy(true)
    try {
      await transport.call<void>("companion_push_configure_hms", {
        appId: hms.appId.trim(),
        clientSecret: hms.clientSecret.trim(),
      })
      setHms((prev) => ({ ...prev, clientSecret: "" }))
      toast.success(t("hmsConfigured"))
      await refresh()
    } catch (err) {
      toast.error(
        t("hmsConfigureFailed", { message: err instanceof Error ? err.message : String(err) })
      )
    } finally {
      setBusy(false)
    }
  }, [hms, refresh, t])

  const onClearHms = useCallback(async () => {
    setBusy(true)
    try {
      await transport.call<void>("companion_push_clear_hms")
      setHms((prev) => ({ ...prev, clientSecret: "" }))
      toast.success(t("hmsCleared"))
      await refresh()
    } catch (err) {
      toast.error(
        t("hmsClearFailed", { message: err instanceof Error ? err.message : String(err) })
      )
    } finally {
      setBusy(false)
    }
  }, [refresh, t])

  const fcmDisabled = !fcmReach.available || busy
  const apnsDisabled = !apnsReach.available || busy
  const hmsSupported = status?.hmsConfigured !== undefined
  const hmsDisabled = !hmsReach.available || !hmsSupported || busy

  return (
    <SettingsBlock
      icon={<BellIcon />}
      title={t("title")}
      description={t("description")}
      testid="push-credentials-block"
      settingId="companion-push"
      contentClassName="space-y-5"
    >
      {reach.block ? <HostReachNotice block={reach.block} testid="push-reach" /> : null}
      {available && statusFailed ? (
        <div className="space-y-2">
          <p role="alert" className="text-xs text-destructive">
            {t("statusLoadFailed")}
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void refresh()}
            disabled={statusLoading || busy}
            aria-busy={statusLoading}
          >
            {t("statusRetry")}
          </Button>
        </div>
      ) : null}

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Label className="text-xs font-medium">{t("fcmLabel")}</Label>
          {status?.fcmConfigured ? (
            <Badge variant="outline" className="text-[10px] uppercase">
              {t("configured")}
            </Badge>
          ) : null}
        </div>
        <Textarea
          className="h-32 resize-y font-mono text-[10px]"
          placeholder={t("fcmPlaceholder")}
          value={fcmJson}
          onChange={(e) => setFcmJson(e.target.value)}
          disabled={fcmDisabled}
          aria-label={t("fcmAria")}
        />
        <div className="flex gap-2">
          <Button size="sm" onClick={() => void onSubmitFcm()} disabled={fcmDisabled}>
            {t("saveFcm")}
          </Button>
          {status?.fcmConfigured ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void onClearFcm()}
              disabled={!fcmClearReach.available || busy}
            >
              {t("clearFcm")}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Label className="text-xs font-medium">{t("hmsLabel")}</Label>
          {status?.hmsConfigured ? (
            <Badge variant="outline" className="text-[10px] uppercase">
              {t("configured")}
            </Badge>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">{t("hmsDescription")}</p>
        {hmsReach.block && hmsReach.block !== reach.block ? (
          <HostReachNotice block={hmsReach.block} testid="hms-push-reach" />
        ) : null}
        {status && !hmsSupported ? (
          <p role="status" className="text-xs text-muted-foreground">
            {t("hmsUnsupported")}
          </p>
        ) : null}
        <div className="grid grid-cols-1 gap-2 @md/settings-stack:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="hms-app-id" className="text-[10px] text-muted-foreground">
              {t("hmsAppId")}
            </Label>
            <Input
              id="hms-app-id"
              value={hms.appId}
              onChange={(e) => setHms({ ...hms, appId: e.target.value })}
              disabled={hmsDisabled}
              autoComplete="off"
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="hms-client-secret" className="text-[10px] text-muted-foreground">
              {t("hmsClientSecret")}
            </Label>
            <Input
              id="hms-client-secret"
              type="password"
              value={hms.clientSecret}
              onChange={(e) => setHms({ ...hms, clientSecret: e.target.value })}
              disabled={hmsDisabled}
              autoComplete="new-password"
              className="font-mono text-xs"
            />
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => void onSubmitHms()} disabled={hmsDisabled}>
            {t("saveHms")}
          </Button>
          {status?.hmsConfigured ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void onClearHms()}
              disabled={!hmsClearReach.available || busy}
            >
              {t("clearHms")}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Label className="text-xs font-medium">{t("apnsLabel")}</Label>
          {status?.apnsConfigured ? (
            <Badge variant="outline" className="text-[10px] uppercase">
              {t("configured")}
            </Badge>
          ) : null}
        </div>
        <div className="grid grid-cols-1 gap-2 @md/settings-stack:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">{t("keyId")}</Label>
            <Input
              value={apns.keyId}
              onChange={(e) => setApns({ ...apns, keyId: e.target.value })}
              placeholder={t("apnsKeyIdPlaceholder")}
              disabled={apnsDisabled}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">{t("teamId")}</Label>
            <Input
              value={apns.teamId}
              onChange={(e) => setApns({ ...apns, teamId: e.target.value })}
              placeholder={t("apnsTeamIdPlaceholder")}
              disabled={apnsDisabled}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1 @md/settings-stack:col-span-2">
            <Label className="text-[10px] text-muted-foreground">{t("bundleId")}</Label>
            <Input
              value={apns.bundleId}
              onChange={(e) => setApns({ ...apns, bundleId: e.target.value })}
              placeholder={t("apnsBundleIdPlaceholder")}
              disabled={apnsDisabled}
              className="font-mono text-xs"
            />
          </div>
        </div>
        <Textarea
          className="h-32 resize-y font-mono text-[10px]"
          placeholder={t("apnsKeyPlaceholder")}
          value={apns.privateKeyPem}
          onChange={(e) => setApns({ ...apns, privateKeyPem: e.target.value })}
          disabled={apnsDisabled}
          aria-label={t("apnsKeyAria")}
        />
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5">
            <Checkbox
              id="apns-production"
              checked={apns.production}
              onCheckedChange={(v) => setApns({ ...apns, production: v === true })}
              disabled={apnsDisabled}
              aria-label={t("productionAria")}
            />
            <Label htmlFor="apns-production" className="text-xs font-normal">
              {t("productionEnv")}
            </Label>
          </div>
          <Button size="sm" onClick={() => void onSubmitApns()} disabled={apnsDisabled}>
            {t("saveApns")}
          </Button>
          {status?.apnsConfigured ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void onClearApns()}
              disabled={!apnsClearReach.available || busy}
            >
              {t("clearApns")}
            </Button>
          ) : null}
        </div>
      </div>
    </SettingsBlock>
  )
}
