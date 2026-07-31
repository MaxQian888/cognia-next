"use client"

/**
 * Settings → Network Proxy → IP. Shows the current public egress IP and its
 * geolocation via `ipinfo.io` (routed through the active proxy in Tauri, so it
 * reports the proxy's IP when one is set).
 *
 * Gated behind the `networkProxy.ipLookupEnabled` master switch — with it off,
 * the tab never contacts the public endpoint. The switch defaults on.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { GlobeIcon, RefreshCwIcon, AlertTriangleIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Skeleton } from "@/components/ui/skeleton"

import { useSettingsStore } from "@/stores/settings"
import { fetchIpInfo, type IpInfoResult } from "@/lib/network/ip-info"
import { DEFAULT_NETWORK_PROXY_SETTINGS, type NetworkProxySettings } from "@/types/network/proxy"

export function NetworkIpInfoTab() {
  const t = useTranslations("settings.network")
  const settings = useSettingsStore((s) => s.settings?.networkProxy)
  const save = useSettingsStore((s) => s.save)

  const cfg: NetworkProxySettings = settings ?? DEFAULT_NETWORK_PROXY_SETTINGS
  const enabled = cfg.ipLookupEnabled

  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<IpInfoResult | null>(null)

  // Button handler — owns the loading state (setState in an event handler is
  // fine; setState directly in an effect body is not).
  const refresh = async () => {
    setLoading(true)
    try {
      setResult(await fetchIpInfo())
    } finally {
      setLoading(false)
    }
  }

  // Auto-fetch on mount (and when the switch is flipped on) — never when off.
  // The result is committed in the async `.then` callback, not synchronously
  // in the effect body. No cleanup of `result` is needed: the result card is
  // gated behind `enabled`, so a stale value is simply never rendered.
  useEffect(() => {
    if (!enabled) return
    let active = true
    void fetchIpInfo().then((r) => {
      if (active) setResult(r)
    })
    return () => {
      active = false
    }
  }, [enabled])

  const toggle = async (next: boolean) => {
    await save({ networkProxy: { ...cfg, ipLookupEnabled: next } })
  }

  const info = result?.ok ? result.info : null

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-md border p-3">
        <div className="space-y-0.5">
          <Label className="text-sm">{t("ipInfo.enableLabel")}</Label>
          <p className="text-xs text-muted-foreground">{t("ipInfo.enableHint")}</p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(v) => void toggle(v)}
          aria-label={t("ipInfo.enableLabel")}
        />
      </div>

      {!enabled && (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground" data-testid="ip-info-disabled">
            {t("ipInfo.disabled")}
          </CardContent>
        </Card>
      )}

      {enabled && (
        <>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <GlobeIcon className="size-4 text-muted-foreground" />
              <p className="text-sm font-medium">{t("ipInfo.heading")}</p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void refresh()}
              disabled={loading}
              aria-label={t("ipInfo.refresh")}
            >
              <RefreshCwIcon className={loading ? "size-4 animate-spin" : "size-4"} />
              {t("ipInfo.refresh")}
            </Button>
          </div>

          {loading && !info && <Skeleton className="h-40 w-full" />}

          {!loading && result && !result.ok && (
            <Card>
              <CardContent className="flex items-center gap-2 p-4 text-sm text-destructive">
                <AlertTriangleIcon className="size-4" />
                <span data-testid="ip-info-error">
                  {t("ipInfo.error", { error: result.error })}
                </span>
              </CardContent>
            </Card>
          )}

          {info && (
            <Card>
              <CardContent className="p-4">
                <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2" data-testid="ip-info">
                  <IpField label={t("ipInfo.fields.ip")} value={info.ip} mono />
                  <IpField label={t("ipInfo.fields.hostname")} value={info.hostname} mono />
                  <IpField label={t("ipInfo.fields.city")} value={info.city} />
                  <IpField label={t("ipInfo.fields.region")} value={info.region} />
                  <IpField label={t("ipInfo.fields.country")} value={info.country} />
                  <IpField label={t("ipInfo.fields.postal")} value={info.postal} />
                  <IpField label={t("ipInfo.fields.org")} value={info.org} />
                  <IpField label={t("ipInfo.fields.loc")} value={info.loc} mono />
                  <IpField label={t("ipInfo.fields.timezone")} value={info.timezone} />
                </dl>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  )
}

function IpField({ label, value, mono }: { label: string; value?: string; mono?: boolean }) {
  if (!value) return null
  return (
    <div className="flex flex-col">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? "font-mono break-all" : "break-all"}>{value}</dd>
    </div>
  )
}
