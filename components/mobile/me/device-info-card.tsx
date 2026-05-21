"use client"

/**
 * Read-only device info card for `/me/device-info`. Surfaces:
 *   • App version / build (via `@capacitor/app`).
 *   • Static device fingerprint (`navigator.userAgent` is the lowest
 *     common denominator that works on every shell).
 *   • Permission status for biometric / push / local notifications.
 *
 * Every read swallows errors — missing plugins / web fallbacks all
 * collapse to "unsupported" rows rather than crashing the page.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { BellIcon, FingerprintIcon, InfoIcon, SmartphoneIcon } from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
} from "@/components/ui/item"
import { Badge } from "@/components/ui/badge"
import { APP_VERSION } from "@/lib/app-version"
import {
  isAvailable as biometricIsAvailable,
  type AvailabilityInfo,
} from "@/lib/capacitor/biometric"
import { checkPermission as checkLocal } from "@/lib/capacitor/local-notifications"

interface AppInfo {
  version: string
  build: string | null
}

async function loadAppInfo(): Promise<AppInfo> {
  try {
    const moduleId = "@capacitor/app"
    const mod = (await import(/* webpackIgnore: true */ moduleId)) as {
      App: { getInfo(): Promise<{ version: string; build: string }> }
    }
    const info = await mod.App.getInfo()
    return { version: info.version, build: info.build }
  } catch {
    return { version: APP_VERSION, build: null }
  }
}

export type PermissionStatus = "granted" | "denied" | "prompt" | "unsupported" | "unknown"

interface Permissions {
  biometric: PermissionStatus
  biometryType?: string
  localNotifications: PermissionStatus
}

async function loadPermissions(): Promise<Permissions> {
  let biometric: PermissionStatus = "unsupported"
  let biometryType: string | undefined
  try {
    const out = await biometricIsAvailable()
    if (out.kind === "ok") {
      const value = out.value as AvailabilityInfo
      biometric = value.available ? "granted" : "denied"
      biometryType = value.biometryType
    } else {
      biometric = "unsupported"
    }
  } catch {
    biometric = "unsupported"
  }

  let localNotifications: PermissionStatus = "unknown"
  try {
    const out = await checkLocal()
    if (out.kind === "ok") {
      localNotifications = out.value
    } else {
      localNotifications = "unsupported"
    }
  } catch {
    localNotifications = "unsupported"
  }

  return { biometric, biometryType, localNotifications }
}

function statusVariant(s: PermissionStatus): "outline" | "secondary" {
  return s === "granted" ? "secondary" : "outline"
}

function statusBadgeText(s: PermissionStatus, t: ReturnType<typeof useTranslations>): string {
  return t(`status.${s}`)
}

export interface DeviceInfoCardProps {
  /** Override the loader (tests). */
  appInfoLoader?: () => Promise<AppInfo>
  permissionsLoader?: () => Promise<Permissions>
}

export function DeviceInfoCard({ appInfoLoader, permissionsLoader }: DeviceInfoCardProps = {}) {
  const t = useTranslations("mobile.me.device")
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [perms, setPerms] = useState<Permissions | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [info, p] = await Promise.all([
        (appInfoLoader ?? loadAppInfo)(),
        (permissionsLoader ?? loadPermissions)(),
      ])
      if (cancelled) return
      setAppInfo(info)
      setPerms(p)
    })()
    return () => {
      cancelled = true
    }
  }, [appInfoLoader, permissionsLoader])

  const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : t("uaUnknown")

  return (
    <div className="flex flex-col gap-3" data-testid="device-info-card">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <SmartphoneIcon className="size-4" aria-hidden="true" />
            {t("hardwareTitle")}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 px-4 pb-3 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">{t("appVersion")}</span>
            <span className="font-mono">
              {appInfo?.version ?? APP_VERSION}
              {appInfo?.build ? ` (${appInfo.build})` : ""}
            </span>
          </div>
          <div className="flex items-start justify-between gap-2">
            <span className="shrink-0 text-muted-foreground">{t("userAgent")}</span>
            <span className="ml-2 font-mono break-all text-right">{userAgent}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <FingerprintIcon className="size-4" aria-hidden="true" />
            {t("permissionsTitle")}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <ItemGroup className="border-t" aria-label={t("permissionsTitle")}>
            <Item size="sm" className="px-4" data-testid="device-row-biometric">
              <ItemContent>
                <ItemTitle className="text-sm">{t("biometricLabel")}</ItemTitle>
                {perms?.biometryType ? (
                  <ItemDescription className="text-xs">{perms.biometryType}</ItemDescription>
                ) : null}
              </ItemContent>
              <ItemActions>
                <Badge variant={statusVariant(perms?.biometric ?? "unknown")}>
                  {statusBadgeText(perms?.biometric ?? "unknown", t)}
                </Badge>
              </ItemActions>
            </Item>
            <ItemSeparator />
            <Item size="sm" className="px-4" data-testid="device-row-local">
              <ItemContent>
                <ItemTitle className="flex items-center gap-1.5 text-sm">
                  <BellIcon className="size-3.5" aria-hidden="true" />
                  {t("localLabel")}
                </ItemTitle>
              </ItemContent>
              <ItemActions>
                <Badge variant={statusVariant(perms?.localNotifications ?? "unknown")}>
                  {statusBadgeText(perms?.localNotifications ?? "unknown", t)}
                </Badge>
              </ItemActions>
            </Item>
          </ItemGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <InfoIcon className="size-4" aria-hidden="true" />
            {t("aboutTitle")}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-3 text-xs text-muted-foreground">
          {t("aboutBody")}
        </CardContent>
      </Card>
    </div>
  )
}
