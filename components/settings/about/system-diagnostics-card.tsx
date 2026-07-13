"use client"

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { ClipboardCopyIcon, FolderOpenIcon, MonitorCogIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { APP_NAME, APP_VERSION } from "@/lib/app-metadata"
import { loggers } from "@cognia/logging"
import { isTauri } from "@/lib/tauri"
import { writeClipboardText } from "@/lib/tauri/clipboard"
import { getOsInfo, type OsInfo } from "@/lib/tauri/os"
import { revealInExplorer } from "@/lib/tauri/opener"
import {
  getCrashLoggingDiagnostics,
  type CrashLoggingDiagnostics,
} from "@/lib/native/crash-reports"
import { getNativeLoggingReadiness } from "@/lib/native/native-logging"
import type { NativeLoggingReadiness } from "@/lib/native/native-logging-readiness"

import { InfoRow } from "./info-row"

/** Human-readable byte size for the log-footprint row. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

async function loadDataDir(): Promise<string | null> {
  if (!isTauri()) return null
  try {
    const { appDataDir } = await import("@tauri-apps/api/path")
    return await appDataDir()
  } catch {
    return null
  }
}

export interface SystemDiagnosticsCardProps {
  /** Test seams. */
  osLoader?: () => Promise<OsInfo | null>
  dataDirLoader?: () => Promise<string | null>
  diagnosticsLoader?: () => Promise<CrashLoggingDiagnostics | null>
  nativeLoggingLoader?: () => Promise<NativeLoggingReadiness | null>
}

/**
 * System / environment facts plus a one-tap "copy diagnostics" button for bug
 * reports and a "reveal data dir" action (desktop). Mirrors the diagnostics
 * pattern in `components/settings/desktop-section.tsx`.
 */
export function SystemDiagnosticsCard({
  osLoader,
  dataDirLoader,
  diagnosticsLoader,
  nativeLoggingLoader,
}: SystemDiagnosticsCardProps = {}) {
  const t = useTranslations("settings.about")
  const [osInfo, setOsInfo] = useState<OsInfo | null>(null)
  const [dataDir, setDataDir] = useState<string | null>(null)
  const [crashDiag, setCrashDiag] = useState<CrashLoggingDiagnostics | null>(null)
  const [nativeLogging, setNativeLogging] = useState<NativeLoggingReadiness | null>(null)

  useEffect(() => {
    let cancelled = false
    void (osLoader ?? getOsInfo)().then((info) => {
      if (!cancelled) setOsInfo(info)
    })
    void (dataDirLoader ?? loadDataDir)().then((dir) => {
      if (!cancelled) setDataDir(dir)
    })
    void (diagnosticsLoader ?? getCrashLoggingDiagnostics)().then((diag) => {
      if (!cancelled) setCrashDiag(diag)
    })
    void (nativeLoggingLoader ?? getNativeLoggingReadiness)().then((readiness) => {
      if (!cancelled) setNativeLogging(readiness)
    })
    return () => {
      cancelled = true
    }
  }, [osLoader, dataDirLoader, diagnosticsLoader, nativeLoggingLoader])

  const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : ""

  const diagnostics = useMemo(() => {
    return [
      `App: ${APP_NAME} ${APP_VERSION}`,
      osInfo ? `OS: ${osInfo.osType} ${osInfo.version} (${osInfo.arch}, ${osInfo.family})` : null,
      osInfo?.locale ? `Locale: ${osInfo.locale}` : null,
      osInfo?.hostname ? `Hostname: ${osInfo.hostname}` : null,
      dataDir ? `Data dir: ${dataDir}` : null,
      userAgent ? `User agent: ${userAgent}` : null,
      `Global error handlers: ready`,
      crashDiag ? `Crash reports: ${crashDiag.crashReportCount}` : null,
      crashDiag?.latestCrashAt ? `Last crash: ${crashDiag.latestCrashAt}` : null,
      crashDiag ? `Log footprint: ${formatBytes(crashDiag.logDirBytes)}` : null,
      crashDiag
        ? `Retention: ${crashDiag.retentionMaxAgeDays}d / ${crashDiag.retentionMaxReports} reports, keep ${crashDiag.rotatedLogKeep} logs`
        : null,
      nativeLogging
        ? `Native logging: ${nativeLogging.startupMode} / ${nativeLogging.startupHealth}`
        : null,
    ]
      .filter(Boolean)
      .join("\n")
  }, [osInfo, dataDir, userAgent, crashDiag, nativeLogging])

  const handleCopy = async () => {
    try {
      await writeClipboardText(diagnostics)
      loggers.app.info("about.copyDiagnostics", { length: diagnostics.length })
      toast.success(t("system.copySuccess"))
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err)
      loggers.app.error("about.copyDiagnosticsFailed", err)
      toast.error(t("system.copyFailed", { error: errorText }))
    }
  }

  const handleReveal = async () => {
    if (!dataDir) return
    try {
      await revealInExplorer(dataDir)
      loggers.app.info("about.revealDataDir", { path: dataDir })
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err)
      loggers.app.error("about.revealDataDirFailed", err)
      toast.error(t("system.revealFailed", { error: errorText }))
    }
  }

  return (
    <Card data-testid="about-system-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MonitorCogIcon className="size-4" />
          {t("system.title")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {osInfo ? (
          <>
            <InfoRow
              label={t("system.os")}
              value={`${osInfo.osType} ${osInfo.version}`}
              testid="row-os"
            />
            <InfoRow label={t("system.arch")} value={osInfo.arch} mono testid="row-arch" />
            {osInfo.locale && (
              <InfoRow label={t("system.locale")} value={osInfo.locale} testid="row-locale" />
            )}
          </>
        ) : (
          <InfoRow
            label={t("system.locale")}
            value={t("system.unavailable")}
            testid="row-locale-fallback"
          />
        )}
        {dataDir && (
          <InfoRow label={t("system.dataDir")} value={dataDir} mono testid="row-data-dir" />
        )}

        <div className="mt-4 mb-1 text-sm font-medium text-muted-foreground">
          {t("crashLogs.title")}
        </div>
        <InfoRow
          label={t("crashLogs.globalErrorHandlers")}
          value={t("crashLogs.ready")}
          testid="row-global-error-handlers"
        />
        {crashDiag ? (
          <>
            <InfoRow
              label={t("crashLogs.crashReports")}
              value={String(crashDiag.crashReportCount)}
              testid="row-crash-count"
            />
            {crashDiag.latestCrashAt && (
              <InfoRow
                label={t("crashLogs.lastCrash")}
                value={crashDiag.latestCrashAt}
                testid="row-last-crash"
              />
            )}
            <InfoRow
              label={t("crashLogs.logFootprint")}
              value={formatBytes(crashDiag.logDirBytes)}
              testid="row-log-footprint"
            />
            <InfoRow
              label={t("crashLogs.retention")}
              value={t("crashLogs.retentionValue", {
                days: crashDiag.retentionMaxAgeDays,
                reports: crashDiag.retentionMaxReports,
                logs: crashDiag.rotatedLogKeep,
              })}
              testid="row-retention"
            />
            {nativeLogging && (
              <InfoRow
                label={t("crashLogs.nativeLogging")}
                value={`${nativeLogging.startupMode} / ${nativeLogging.startupHealth}`}
                testid="row-native-logging"
              />
            )}
          </>
        ) : (
          <InfoRow
            label={t("crashLogs.crashReports")}
            value={t("system.unavailable")}
            testid="row-crash-unavailable"
          />
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={handleCopy} data-testid="copy-diagnostics">
            <ClipboardCopyIcon className="mr-2 size-4" />
            {t("system.copy")}
          </Button>
          {dataDir && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleReveal}
              data-testid="reveal-data-dir"
            >
              <FolderOpenIcon className="mr-2 size-4" />
              {t("system.reveal")}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
