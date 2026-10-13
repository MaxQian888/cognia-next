"use client"

/**
 * What a Host machine is: its operating system, kernel, processor and memory,
 * read from the Host itself (`perf_system_details`) over its management
 * channel. Identity says who the Host is to this app; this says what it runs
 * on, which is what someone looking at a cloud machine they pay for asks.
 *
 * Read once on open and on demand. Memory in use is that moment's reading.
 */

import { RefreshCwIcon, ServerIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { useHostSystem } from "@/hooks/remote-host/use-host-system"
import { managementRefOf } from "@/lib/devices/section-plan"
import type { DeviceRow } from "@/lib/devices/types"
import { formatBytes, formatCount } from "@/lib/perf/backend/format"
import type { SystemDetails } from "@/lib/perf/backend/types"
import { hostOsLabel } from "@/lib/remote-host/host-system"
import { cn } from "@/lib/utils"

import { DeviceSection } from "../device-section"
import { DeviceFactList, DeviceFactRow } from "../device-visuals"

/** Placeholder for a field the Host did not report. Not linguistic. */
const UNKNOWN = "—"

export function HostSystemSection({
  row,
  load,
}: {
  row: DeviceRow
  load?: (hostRef: string) => Promise<SystemDetails>
}) {
  const t = useTranslations("devices.hostSystem")
  const labels = useTranslations("performance.system")
  const { details, error, loading, reload } = useHostSystem(managementRefOf(row), load)

  const refresh = (
    <Button
      size="sm"
      variant="ghost"
      className="size-6 p-0"
      aria-label={t("refresh")}
      disabled={loading}
      onClick={() => void reload()}
      data-testid="host-system-refresh"
    >
      <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
    </Button>
  )

  return (
    <DeviceSection id="host-system" title={t("title")} icon={ServerIcon} meta={refresh}>
      {!details ? (
        <p className="text-sm text-muted-foreground" data-testid="host-system-status">
          {error ? t("unreachable", { error }) : t("loading")}
        </p>
      ) : (
        <div className="space-y-3" data-testid="host-system">
          <DeviceFactList>
            <DeviceFactRow label={labels("host.os")}>
              <span data-testid="host-system-os">{hostOsLabel(details) ?? UNKNOWN}</span>
            </DeviceFactRow>
            <DeviceFactRow label={labels("host.kernel")} mono>
              {details.kernelVersion ?? UNKNOWN}
            </DeviceFactRow>
            <DeviceFactRow label={labels("host.hostname")} mono>
              {details.hostname ?? UNKNOWN}
            </DeviceFactRow>
            <DeviceFactRow label={labels("host.arch")} mono>
              {details.arch}
            </DeviceFactRow>
            <DeviceFactRow label={labels("hardware.cpu")}>{details.cpu ?? UNKNOWN}</DeviceFactRow>
            <DeviceFactRow label={labels("hardware.cores")} mono>
              {formatCount(details.cpuCount)}
            </DeviceFactRow>
            <DeviceFactRow label={labels("hardware.totalMemory")} mono>
              <span data-testid="host-system-memory">
                {t("memory", {
                  used: formatBytes(details.usedMemoryBytes),
                  total: formatBytes(details.totalMemoryBytes),
                })}
              </span>
            </DeviceFactRow>
          </DeviceFactList>
          {error ? (
            <p className="text-xs text-destructive" data-testid="host-system-error">
              {t("unreachable", { error })}
            </p>
          ) : null}
        </div>
      )}
    </DeviceSection>
  )
}
