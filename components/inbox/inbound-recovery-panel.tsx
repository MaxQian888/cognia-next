"use client"

/**
 * Durable inbound jobs for this conversation that stalled mid-flight and need
 * an operator decision.
 *
 * Presentation only — `useInboundRecoveryJobs` owns the query and
 * `InboxNoticeArea` decides whether to mount it.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import {
  dismissConnectorInboundJobRecovery,
  retryConnectorInboundJobFromStart,
} from "@/lib/db/connector-inbound-jobs"
import { resumeCrashedAgentRun } from "@/lib/ai/agent/recovery/reconcile-crashed-runs"
import { getBus } from "@/lib/connectors/bus"
import type { ConnectorInboundJobRow } from "@/lib/db/connector-types"
import { NoticeItem } from "./notices/notice-item"

export interface InboundRecoveryNoticeProps {
  jobs: ConnectorInboundJobRow[]
}

export function InboundRecoveryNotice({ jobs }: InboundRecoveryNoticeProps) {
  const t = useTranslations("inbox.inboundRecovery")
  const [workingId, setWorkingId] = useState<string>()

  if (jobs.length === 0) return null

  const resolve = async (id: string, action: "continue" | "retry" | "dismiss"): Promise<void> => {
    if (action === "retry" && !window.confirm(t("retryWarning"))) return
    setWorkingId(id)
    try {
      const changed =
        action === "continue"
          ? (await resumeCrashedAgentRun(jobs.find((job) => job.id === id)?.executionRunId ?? ""))
              .resumed
          : action === "retry"
            ? await retryConnectorInboundJobFromStart(id, { confirmed: true })
            : await dismissConnectorInboundJobRecovery(id)
      if (changed && action !== "dismiss") await getBus().resumeDurableInboundJobs()
    } finally {
      setWorkingId(undefined)
    }
  }

  return (
    <NoticeItem severity="warning" title={t("title")} data-testid="inbound-recovery-panel">
      <p className="mt-0.5 text-muted-foreground">{t("description")}</p>
      <div className="mt-1 space-y-1">
        {jobs.map((job) => (
          <div key={job.id} className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 truncate">
              {t("message", {
                id: job.sourceMessageId,
                reason: job.recoveryReason ?? t("unknown"),
              })}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              disabled={workingId === job.id}
              onClick={() => void resolve(job.id, "continue")}
            >
              {t("continueSafely")}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              className="h-6 px-2 text-[11px]"
              disabled={workingId === job.id}
              onClick={() => void resolve(job.id, "retry")}
            >
              {t("retryFromStart")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              disabled={workingId === job.id}
              onClick={() => void resolve(job.id, "dismiss")}
            >
              {t("dismiss")}
            </Button>
          </div>
        ))}
      </div>
    </NoticeItem>
  )
}
