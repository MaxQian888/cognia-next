"use client"

/**
 * PerfSystemTab — the static host + build facts every task manager shows:
 * OS, kernel, CPU model and core count, installed memory, and which build of
 * the app is running.
 *
 * These come from `perf_system_details` (the same `crash::system_info::gather`
 * a crash report embeds). They are immutable for the life of the process, so
 * this fetches once on mount rather than riding the 1 Hz sample frame.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { CpuIcon, MonitorIcon, PackageIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { perfSystemDetails } from "@/lib/perf/backend/commands"
import { formatBytes, formatCount } from "@/lib/perf/backend/format"
import type { SystemDetails } from "@/lib/perf/backend/types"

/** Placeholder for a field the host didn't report. Not linguistic. */
const UNKNOWN = "—"

interface FactRowProps {
  label: string
  value: string
  testId: string
}

function FactRow({ label, value, testId }: FactRowProps) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="truncate text-right font-mono text-sm tabular-nums" data-testid={testId}>
        {value}
      </dd>
    </div>
  )
}

export interface PerfSystemTabProps {
  /**
   * Injected in tests / stories; defaults to the real command, which resolves
   * `null` when there is no native runtime.
   */
  load?: () => Promise<SystemDetails | null>
}

export function PerfSystemTab({ load = perfSystemDetails }: PerfSystemTabProps) {
  const t = useTranslations("performance.system")
  const [details, setDetails] = useState<SystemDetails | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    void load()
      .then((d) => {
        if (cancelled) return
        // `null` means no native runtime — same dead end for the user as a
        // thrown error, so don't leave them on a spinner forever.
        if (d) setDetails(d)
        else setFailed(true)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [load])

  if (failed) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground" data-testid="perf-system-error">
        {t("error")}
      </p>
    )
  }

  if (!details) {
    return (
      <p
        className="py-8 text-center text-sm text-muted-foreground"
        data-testid="perf-system-loading"
      >
        {t("loading")}
      </p>
    )
  }

  const osLine = [details.os, details.osVersion].filter(Boolean).join(" ")

  return (
    <div className="grid gap-4 md:grid-cols-3" data-testid="perf-system-tab">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <MonitorIcon className="size-4 text-chart-1" />
            {t("host.title")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="divide-y">
            <FactRow label={t("host.os")} value={osLine || UNKNOWN} testId="perf-system-os" />
            <FactRow
              label={t("host.kernel")}
              value={details.kernelVersion ?? UNKNOWN}
              testId="perf-system-kernel"
            />
            <FactRow
              label={t("host.hostname")}
              value={details.hostname ?? UNKNOWN}
              testId="perf-system-hostname"
            />
            <FactRow
              label={t("host.arch")}
              value={`${details.arch} · ${details.family}`}
              testId="perf-system-arch"
            />
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <CpuIcon className="size-4 text-chart-2" />
            {t("hardware.title")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="divide-y">
            <FactRow
              label={t("hardware.cpu")}
              value={details.cpu ?? UNKNOWN}
              testId="perf-system-cpu"
            />
            <FactRow
              label={t("hardware.cores")}
              value={formatCount(details.cpuCount)}
              testId="perf-system-cores"
            />
            <FactRow
              label={t("hardware.totalMemory")}
              value={formatBytes(details.totalMemoryBytes)}
              testId="perf-system-total-mem"
            />
            <FactRow
              label={t("hardware.usedMemory")}
              value={formatBytes(details.usedMemoryBytes)}
              testId="perf-system-used-mem"
            />
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <PackageIcon className="size-4 text-chart-5" />
            {t("build.title")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="divide-y">
            <FactRow
              label={t("build.appVersion")}
              value={details.appVersion}
              testId="perf-system-app-version"
            />
            <FactRow
              label={t("build.tauriVersion")}
              value={details.tauriVersion}
              testId="perf-system-tauri-version"
            />
            <FactRow
              label={t("build.profile")}
              value={details.profile}
              testId="perf-system-profile"
            />
          </dl>
          <div className="mt-3">
            <p className="mb-1.5 text-sm text-muted-foreground">{t("build.features")}</p>
            {details.enabledFeatures.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="perf-system-no-features">
                {t("build.noFeatures")}
              </p>
            ) : (
              <div className="flex flex-wrap gap-1" data-testid="perf-system-features">
                {details.enabledFeatures.map((f) => (
                  <Badge key={f} variant="secondary" className="font-mono text-xs">
                    {f}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
