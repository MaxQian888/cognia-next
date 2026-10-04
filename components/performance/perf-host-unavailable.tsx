"use client"

/**
 * Why a host-only section is empty.
 *
 * The Resources sub-tabs used to be `disabled` whenever no host frames had
 * arrived, with nothing saying why: on web that is permanent (there is no
 * host), on desktop it is usually a lease still connecting or held by another
 * window, and those call for different reactions. This panel names the state,
 * the typed lease issue when there is one, and where to look next.
 */

import { useTranslations } from "next-intl"
import { ChevronRightIcon, ServerOffIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import type { PerfConnectionState } from "@/lib/perf/backend/types"
import type { PerfHostIssue } from "@/lib/perf/host-live-lease"

export interface PerfHostUnavailableProps {
  hostState: PerfConnectionState
  issue?: PerfHostIssue | null
  /** What the section would show, e.g. "processes" — picks the title. */
  section: "processes" | "runtime" | "managed" | "system" | "hotspots"
  /** Optional jump to the Diagnose tab's source details. */
  onOpenDiagnose?: () => void
  /**
   * The host is live but its runtime does not report this section (e.g. the
   * Node host has no Tokio runtime). Distinct from "no host".
   */
  notReported?: boolean
}

export function PerfHostUnavailable({
  hostState,
  issue = null,
  section,
  onOpenDiagnose,
  notReported = false,
}: PerfHostUnavailableProps) {
  const t = useTranslations("performance.hostUnavailable")
  // "unsupported" wins over the issue that produced it: on web the lease
  // records an `unreachable` issue, but the honest sentence is "this runtime
  // has no host", not "the host could not be reached".
  const reason = notReported
    ? t("reason.notReported")
    : issue && hostState !== "unsupported"
      ? t(`reason.issue.${issue.kind}`)
      : t(`reason.state.${hostState}`)

  return (
    <Empty
      className="border border-dashed py-10"
      data-testid={`perf-host-unavailable-${section}`}
      data-state={notReported ? "not-reported" : hostState}
    >
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ServerOffIcon aria-hidden />
        </EmptyMedia>
        <EmptyTitle>{t(`title.${section}`)}</EmptyTitle>
        <EmptyDescription>{reason}</EmptyDescription>
      </EmptyHeader>
      {onOpenDiagnose ? (
        <EmptyContent>
          <Button type="button" variant="outline" size="sm" onClick={onOpenDiagnose}>
            {t("openDiagnose")}
            <ChevronRightIcon aria-hidden />
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  )
}
