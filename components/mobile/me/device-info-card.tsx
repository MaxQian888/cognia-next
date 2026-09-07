"use client"

/**
 * Device info & permissions surface for `/me/device-info`. Surfaces:
 *   • App version / build (via `@capacitor/app`).
 *   • Detailed hardware / OS metadata (via `@capacitor/device`) — model,
 *     manufacturer, OS, WebView, memory, storage, battery, language —
 *     supplemented with `navigator`-derived figures (screen, CPU cores,
 *     network) that work in any shell.
 *   • Permission status for biometric / local notifications, each with an
 *     inline action: request the OS prompt, deep-link to system settings,
 *     or run a biometric test.
 *
 * Every read swallows errors — missing plugins / web fallbacks collapse to
 * "unsupported" rows rather than crashing the page.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { BellIcon, ShieldCheckIcon } from "lucide-react"

import { AnimatedActionIcon } from "@/components/shared/animated-action-icon"
import { SettingsIcon as AnimatedSettingsIcon } from "@/components/ui/settings"
import { MeSection } from "@/components/mobile/me/me-section"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemSeparator,
  ItemTitle,
} from "@/components/ui/item"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { APP_VERSION } from "@/lib/app-version"
import {
  isAvailable as biometricIsAvailable,
  verify as biometricVerify,
  type AvailabilityInfo,
} from "@/lib/capacitor/biometric"
import {
  checkPermission as checkLocal,
  emitNotificationPermissionGranted,
  requestPermission as requestLocal,
} from "@/lib/capacitor/local-notifications"
import { getAppInfo } from "@/lib/capacitor/app"
import { getDeviceInfo, type DeviceDetails } from "@/lib/capacitor/device"
import { openAppSettings } from "@/lib/capacitor/app-settings"

interface AppInfo {
  version: string
  build: string | null
}

async function loadAppInfo(): Promise<AppInfo> {
  // getAppInfo resolves through window.Capacitor.Plugins.App — a bare
  // dynamic import never resolves inside the static-export WebView.
  const out = await getAppInfo()
  if (out.kind === "ok") {
    return { version: out.value.version, build: out.value.build }
  }
  return { version: APP_VERSION, build: null }
}

async function loadDevice(): Promise<DeviceDetails | null> {
  try {
    const out = await getDeviceInfo()
    return out.kind === "ok" ? out.value : null
  } catch {
    return null
  }
}

export type PermissionStatus = "granted" | "denied" | "prompt" | "unsupported" | "unknown"
export type BiometricStatus = "available" | "unavailable" | "unsupported"

interface Permissions {
  biometric: BiometricStatus
  biometryType?: string
  localNotifications: PermissionStatus
}

async function loadPermissions(): Promise<Permissions> {
  let biometric: BiometricStatus = "unsupported"
  let biometryType: string | undefined
  try {
    const out = await biometricIsAvailable()
    if (out.kind === "ok") {
      const value = out.value as AvailabilityInfo
      // `@capgo/capacitor-native-biometric` reports availability, not a
      // grant/deny permission — map it onto its own status vocabulary so the
      // badge reads "Ready" / "Not enrolled" instead of a misleading "Granted".
      biometric = value.available ? "available" : "unavailable"
      biometryType =
        value.biometryType && value.biometryType !== "NONE" ? value.biometryType : undefined
    }
  } catch {
    biometric = "unsupported"
  }

  let localNotifications: PermissionStatus = "unknown"
  try {
    const out = await checkLocal()
    localNotifications = out.kind === "ok" ? out.value : "unsupported"
  } catch {
    localNotifications = "unsupported"
  }

  return { biometric, biometryType, localNotifications }
}

function notifVariant(s: PermissionStatus): "outline" | "secondary" {
  return s === "granted" ? "secondary" : "outline"
}

function biometricVariant(s: BiometricStatus): "outline" | "secondary" {
  return s === "available" ? "secondary" : "outline"
}

/** Human-friendly byte size. Returns null for missing / non-finite values. */
function formatBytes(bytes?: number): string | null {
  if (bytes == null || !Number.isFinite(bytes)) return null
  const units = ["B", "KB", "MB", "GB", "TB"]
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

interface NavigatorInfo {
  language?: string
  screen?: string
  cores?: number
  online?: boolean
}

function readNavigatorInfo(): NavigatorInfo {
  if (typeof navigator === "undefined") return {}
  const info: NavigatorInfo = {
    language: navigator.language || undefined,
    cores: typeof navigator.hardwareConcurrency === "number" ? navigator.hardwareConcurrency : undefined,
    online: typeof navigator.onLine === "boolean" ? navigator.onLine : undefined,
  }
  if (typeof window !== "undefined" && window.screen?.width) {
    info.screen = `${window.screen.width}×${window.screen.height}`
  }
  return info
}

type InfoRow = { label: string; value: string; mono?: boolean }

export interface DeviceInfoCardProps {
  /** Loader overrides (tests). */
  appInfoLoader?: () => Promise<AppInfo>
  permissionsLoader?: () => Promise<Permissions>
  deviceInfoLoader?: () => Promise<DeviceDetails | null>
  /** Action seams (tests). */
  requester?: typeof requestLocal
  settingsOpener?: typeof openAppSettings
  verifier?: typeof biometricVerify
}

export function DeviceInfoCard({
  appInfoLoader,
  permissionsLoader,
  deviceInfoLoader,
  requester = requestLocal,
  settingsOpener = openAppSettings,
  verifier = biometricVerify,
}: DeviceInfoCardProps = {}) {
  const t = useTranslations("mobile.me.device")
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [device, setDevice] = useState<DeviceDetails | null>(null)
  const [perms, setPerms] = useState<Permissions | null>(null)
  const [requesting, setRequesting] = useState(false)
  const [testing, setTesting] = useState(false)

  const refreshPermissions = useCallback(async () => {
    const p = await (permissionsLoader ?? loadPermissions)()
    setPerms(p)
  }, [permissionsLoader])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [info, dev, p] = await Promise.all([
        (appInfoLoader ?? loadAppInfo)(),
        (deviceInfoLoader ?? loadDevice)(),
        (permissionsLoader ?? loadPermissions)(),
      ])
      if (cancelled) return
      setAppInfo(info)
      setDevice(dev)
      setPerms(p)
    })()
    return () => {
      cancelled = true
    }
  }, [appInfoLoader, deviceInfoLoader, permissionsLoader])

  const onEnableNotifications = useCallback(async () => {
    setRequesting(true)
    try {
      const outcome = await requester()
      if (outcome.kind === "ok" && outcome.value === "granted") {
        emitNotificationPermissionGranted()
      }
      await refreshPermissions()
    } finally {
      setRequesting(false)
    }
  }, [requester, refreshPermissions])

  const onTestBiometric = useCallback(async () => {
    setTesting(true)
    try {
      const outcome = await verifier({ reason: t("biometricTestReason"), title: t("biometricLabel") })
      if (outcome.kind === "verified") {
        toast.success(t("toastTestSuccess"))
      } else if (outcome.kind !== "cancelled") {
        toast.error(t("toastTestFailed"))
      }
    } finally {
      setTesting(false)
    }
  }, [verifier, t])

  const nav = readNavigatorInfo()
  const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : t("uaUnknown")

  const rows: InfoRow[] = []
  rows.push({
    label: t("appVersion"),
    value: `${appInfo?.version ?? APP_VERSION}${appInfo?.build ? ` (${appInfo.build})` : ""}`,
    mono: true,
  })
  if (device?.platform) rows.push({ label: t("platform"), value: device.platform, mono: true })
  if (device?.model) rows.push({ label: t("model"), value: device.model })
  if (device?.manufacturer) rows.push({ label: t("manufacturer"), value: device.manufacturer })
  if (device?.operatingSystem) {
    rows.push({
      label: t("os"),
      value: device.osVersion
        ? `${device.operatingSystem} ${device.osVersion}`
        : device.operatingSystem,
      mono: true,
    })
  }
  if (device?.webViewVersion) {
    rows.push({ label: t("webview"), value: device.webViewVersion, mono: true })
  }
  if (device?.isVirtual) rows.push({ label: t("deviceKind"), value: t("emulator") })
  const memUsed = formatBytes(device?.memUsed)
  if (memUsed) rows.push({ label: t("memoryUsed"), value: memUsed, mono: true })
  const diskFree = formatBytes(device?.realDiskFree)
  const diskTotal = formatBytes(device?.realDiskTotal)
  if (diskFree) {
    rows.push({
      label: t("storageFree"),
      value: diskTotal ? `${diskFree} / ${diskTotal}` : diskFree,
      mono: true,
    })
  }
  if (device?.batteryLevel != null) {
    const pct = Math.round(device.batteryLevel * 100)
    rows.push({
      label: t("battery"),
      value: device.isCharging ? t("batteryCharging", { level: pct }) : `${pct}%`,
      mono: true,
    })
  }
  const language = device?.languageCode ?? nav.language
  if (language) rows.push({ label: t("language"), value: language, mono: true })
  if (nav.screen) rows.push({ label: t("screen"), value: nav.screen, mono: true })
  if (nav.cores != null) rows.push({ label: t("cpuCores"), value: String(nav.cores), mono: true })
  if (nav.online != null) {
    rows.push({ label: t("network"), value: nav.online ? t("online") : t("offline") })
  }

  const biometric = perms?.biometric ?? "unsupported"
  const notif = perms?.localNotifications ?? "unknown"

  return (
    <div className="flex flex-col gap-5" data-testid="device-info-card">
      <MeSection title={t("hardwareTitle")}>
        <div className="flex flex-col gap-2 px-3 py-3 text-xs">
          {rows.map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-3">
              <span className="shrink-0 text-muted-foreground">{row.label}</span>
              <span className={`min-w-0 text-right ${row.mono ? "font-mono" : ""}`}>
                {row.value}
              </span>
            </div>
          ))}
          {/* The user agent is the one value long enough to need its own line.
              Right-aligned beside its label it broke into four ragged lines
              that were harder to read than the string it was showing. */}
          <div className="flex flex-col gap-1 border-t pt-2">
            <span className="text-muted-foreground">{t("userAgent")}</span>
            <span className="font-mono leading-relaxed break-all">{userAgent}</span>
          </div>
        </div>
      </MeSection>

      <MeSection title={t("permissionsTitle")}>
        <Item size="sm" className="px-3 py-2.5" data-testid="device-row-biometric">
          {/* `grow basis-56` rather than the default `flex-1`: flex lines break
              from the hypothetical main size, and `flex-1` pins the basis to 0,
              so the label column reported zero width and the row never wrapped.
              It squeezed "Biometric (Face ID / fingerprint)" into about 90px
              instead, three lines tall beside its own badge and button. The
              basis is written into the shorthand so tailwind-merge drops the
              primitive's `flex-1` rather than leaving both declarations to
              race on stylesheet order. 12rem is the widest basis that still
              leaves a short label its badge on the same line at 375px. */}
          <ItemContent className="min-w-0 flex-[1_1_12rem]">
            <ItemTitle className="flex items-center gap-1.5 text-sm">
              <ShieldCheckIcon className="size-3.5 shrink-0" aria-hidden="true" />
              {t("biometricLabel")}
            </ItemTitle>
            {perms?.biometryType ? (
              <ItemDescription className="text-xs">{perms.biometryType}</ItemDescription>
            ) : biometric === "unavailable" ? (
              <ItemDescription className="text-xs">{t("biometricEnrollHint")}</ItemDescription>
            ) : null}
          </ItemContent>
          <ItemActions className="ml-auto gap-2">
            <Badge variant={biometricVariant(biometric)}>
              {t(`biometricStatus.${biometric}`)}
            </Badge>
            {biometric === "available" ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 touch-target"
                disabled={testing}
                onClick={() => void onTestBiometric()}
                data-testid="device-biometric-test"
              >
                {testing ? t("actions.testing") : t("actions.test")}
              </Button>
            ) : biometric === "unavailable" ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 touch-target"
                onClick={() => void settingsOpener()}
                data-testid="device-biometric-settings"
              >
                <AnimatedActionIcon
                  icon={AnimatedSettingsIcon}
                  size={14}
                  data-icon="inline-start"
                />
                {t("actions.openSettings")}
              </Button>
            ) : null}
          </ItemActions>
        </Item>
        <ItemSeparator />
        <Item size="sm" className="px-3 py-2.5" data-testid="device-row-local">
          <ItemContent className="min-w-0 flex-[1_1_12rem]">
            <ItemTitle className="flex items-center gap-1.5 text-sm">
              <BellIcon className="size-3.5 shrink-0" aria-hidden="true" />
              {t("localLabel")}
            </ItemTitle>
          </ItemContent>
          <ItemActions className="ml-auto gap-2">
            <Badge variant={notifVariant(notif)}>{t(`status.${notif}`)}</Badge>
            {notif === "prompt" ? (
              <Button
                type="button"
                size="sm"
                className="h-7 touch-target"
                disabled={requesting}
                onClick={() => void onEnableNotifications()}
                data-testid="device-local-enable"
              >
                {requesting ? t("actions.enabling") : t("actions.enable")}
              </Button>
            ) : notif === "denied" ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 touch-target"
                onClick={() => void settingsOpener()}
                data-testid="device-local-settings"
              >
                <AnimatedActionIcon
                  icon={AnimatedSettingsIcon}
                  size={14}
                  data-icon="inline-start"
                />
                {t("actions.openSettings")}
              </Button>
            ) : null}
          </ItemActions>
        </Item>
      </MeSection>

      <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">{t("aboutBody")}</p>
    </div>
  )
}
