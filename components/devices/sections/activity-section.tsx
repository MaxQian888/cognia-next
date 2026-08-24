"use client"

/**
 * What has been sent to this device, and what it offers a placement decision.
 *
 * The dispatch queue is the honest answer to "is this machine doing anything",
 * because it is the only durable record of host → target work (ADR-0136 §6).
 * Terminal rows are shown alongside live ones: the console's question is "what
 * has been sent here and how did it go", and hiding failures would answer only
 * the half that never needed explaining.
 *
 * The placement section is the diagnostic half — it lists what this device
 * *provides*, per dimension, which is what `evaluatePlacement` matches
 * requirements against. A machine that never gets picked usually provides
 * nothing in the dimension the caller asked for, and that was previously
 * invisible everywhere.
 */

import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"

import { InboxIcon, TargetIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { dispatchTargetRef } from "@/lib/devices/build-device-rows"
import type { DeviceRow } from "@/lib/devices/types"
import { listHostDispatchForTarget } from "@/lib/db/host-dispatch-queue"
import type { HostDispatchStatus, PlacementDimensionCounts } from "./activity-types"
import { cn } from "@/lib/utils"

import { DeviceSection } from "../device-section"
import { useDeviceRelativeTime } from "../device-visuals"

const STATUS_TONE: Record<HostDispatchStatus, string> = {
  pending: "text-muted-foreground",
  inflight: "text-primary",
  "awaiting-result": "text-primary",
  succeeded: "text-emerald-600 dark:text-emerald-400",
  failed: "text-destructive",
  cancelled: "text-muted-foreground",
  deadletter: "text-destructive",
}

export function summarizeProvides(row: DeviceRow): PlacementDimensionCounts {
  const counts: PlacementDimensionCounts = {}
  for (const requirement of row.placement.provides) {
    counts[requirement.dimension] = (counts[requirement.dimension] ?? 0) + 1
  }
  return counts
}

export function ActivitySection({ row }: { row: DeviceRow }) {
  const t = useTranslations("devices")
  const relative = useDeviceRelativeTime()

  const targetRef = dispatchTargetRef(row)
  const jobs = useLiveQuery(
    () => (targetRef ? listHostDispatchForTarget(targetRef) : Promise.resolve([])),
    [targetRef],
    []
  )

  const provides = useMemo(() => summarizeProvides(row), [row])
  const dimensions = Object.entries(provides)

  return (
    <>
      <DeviceSection
        id="dispatch"
        title={t("activity.dispatch")}
        icon={InboxIcon}
        wide
        meta={targetRef && jobs.length > 0 ? String(jobs.length) : undefined}
      >
        <div data-testid="device-dispatch-queue">
          {!targetRef ? (
            <p className="text-xs text-muted-foreground">{t("activity.dispatchNotAddressable")}</p>
          ) : jobs.length === 0 ? (
            <Empty className="border-none py-4">
              <EmptyHeader>
                <EmptyTitle className="text-sm">{t("activity.dispatchEmptyTitle")}</EmptyTitle>
                <EmptyDescription className="text-xs">
                  {t("activity.dispatchEmptyBody")}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="divide-y divide-border/50">
              {jobs.map((job) => (
                <li key={job.id} className="py-1.5" data-testid={`dispatch-job-${job.id}`}>
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                      {job.kind}
                    </span>
                    <span className={cn("shrink-0 text-[11px]", STATUS_TONE[job.status])}>
                      {t(`activity.status.${job.status}`)}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted-foreground/80">
                      {relative(job.createdAt)}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-baseline gap-2 text-[11px] text-muted-foreground">
                    <span>{t(`activity.domain.${job.domain}`)}</span>
                    {job.attempts > 0 ? (
                      <span className="tabular-nums">
                        {t("activity.attempts", { attempts: job.attempts, max: job.maxAttempts })}
                      </span>
                    ) : null}
                  </div>
                  {job.lastError ? (
                    <p className="mt-0.5 break-all text-[11px] text-destructive">{job.lastError}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </DeviceSection>

      <DeviceSection id="placement" title={t("activity.placement")} icon={TargetIcon}>
        <div data-testid="device-placement-provides">
          {dimensions.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("activity.providesNothing")}</p>
          ) : (
            <>
              <ul className="flex flex-wrap gap-1">
                {dimensions.map(([dimension, count]) => (
                  <li key={dimension}>
                    <Badge variant="outline" className="font-normal">
                      {t(`activity.dimension.${dimension}`)}
                      <span className="ml-1 tabular-nums text-muted-foreground">{count}</span>
                    </Badge>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
                {t("activity.placementHint")}
              </p>
            </>
          )}
        </div>
      </DeviceSection>
    </>
  )
}
