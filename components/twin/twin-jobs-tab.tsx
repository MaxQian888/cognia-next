"use client"

import { memo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { motion, useReducedMotion } from "motion/react"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Button } from "@/components/ui/button"
import { StatusBadge } from "@/components/status-badge"
import { listTwinJobsByTwin, retryFailedJob } from "@/lib/db/twin-jobs"
import { listTwinSourcesByTwinAndStatus } from "@/lib/db/twin-sources"
import { enqueueIngestJob } from "@/lib/twin/ingest"
import { enqueueDistillJob } from "@/lib/twin/distill"
import { parseDeadLetter } from "@/lib/twin/job-retry"
import type { TwinJob, TwinJobStatus } from "@/types/twin"

const STATUS_VARIANT: Record<TwinJobStatus, "default" | "secondary" | "destructive" | "outline"> = {
  queued: "outline",
  running: "secondary",
  paused: "outline",
  completed: "default",
  failed: "destructive",
}

export function TwinJobsTab({ twinId }: { twinId: string }) {
  const t = useTranslations("twin.jobs")
  const prefersReducedMotion = useReducedMotion()
  const jobs = useLiveQuery(() => listTwinJobsByTwin(twinId), [twinId], [])

  const queueIngest = async () => {
    const pending = await listTwinSourcesByTwinAndStatus(twinId, "pending")
    if (pending.length === 0) return
    await enqueueIngestJob({ twinId, sourceIds: pending.map((s) => s.id) })
  }

  const queueDistill = async () => {
    await enqueueDistillJob(twinId)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-medium">{t("headerCount", { count: jobs.length })}</h2>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => void queueIngest()}>
            {t("queueIngest")}
          </Button>
          <Button size="sm" onClick={() => void queueDistill()}>
            {t("queueDistill")}
          </Button>
        </div>
      </div>

      {jobs.length === 0 ? (
        <Card className="p-6 text-center">
          <p className="text-muted-foreground text-sm">{t("emptyHint")}</p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {jobs.map((job, index) => (
            <motion.li
              key={job.id}
              initial={prefersReducedMotion ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: 0.15,
                ease: "easeOut",
                delay: prefersReducedMotion ? 0 : Math.min(index * 0.03, 0.15),
              }}
              className="list-none"
            >
              <JobRow job={job} />
            </motion.li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * A single job card. Memoised — live-query refreshes (progress ticks on the
 * running job) replace only that job's object, so finished rows skip
 * re-rendering.
 */
const JobRow = memo(function JobRow({ job }: { job: TwinJob }) {
  const t = useTranslations("twin.jobs")
  const tKind = useTranslations("twin.kind")
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState<string | null>(null)
  const deadLetter = parseDeadLetter(job.errorMessage)
  const canRetry = job.status === "failed"

  const handleRetry = async () => {
    setRetrying(true)
    setRetryError(null)
    try {
      await retryFailedJob(job.id)
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : String(err))
    } finally {
      setRetrying(false)
    }
  }

  return (
    <Card className="flex flex-col gap-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge
            value={job.status}
            labelNamespace="twin.status"
            variantMap={STATUS_VARIANT}
            pulse={job.status === "running"}
            data-testid={`twin-job-${job.id}-status`}
          />
          <Badge variant="outline">{tKind(job.kind)}</Badge>
          {job.retryCount > 0 && (
            <Badge variant="secondary" className="font-mono text-[10px]">
              {t("attempt", { n: job.retryCount + 1 })}
            </Badge>
          )}
          {deadLetter ? (
            <Badge variant="destructive" className="text-[10px]">
              {t("deadLetter")}
            </Badge>
          ) : null}
          <span className="text-sm font-medium">{job.phase}</span>
        </div>
        <span className="text-muted-foreground text-xs">
          {t("queuedAt", { when: new Date(job.queuedAt).toLocaleString() })}
        </span>
      </div>
      <Progress value={job.progress} max={100} />
      {job.errorMessage ? (
        <p className="text-destructive text-xs">
          {t("errorPrefix")} {deadLetter ? deadLetter.message : job.errorMessage}
        </p>
      ) : null}
      {job.outputDraftIds && job.outputDraftIds.length > 0 ? (
        <p className="text-muted-foreground text-xs">
          {t("draftsProduced", { count: job.outputDraftIds.length })}
        </p>
      ) : null}
      {job.partialFailures && Object.keys(job.partialFailures).length > 0 ? (
        <div className="flex flex-col gap-1" data-testid={`twin-job-${job.id}-partial`}>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-[10px]">
              {t("partialBadge")}
            </Badge>
            <span className="text-muted-foreground text-xs">{t("partialTitle")}</span>
          </div>
          <ul className="text-muted-foreground list-disc pl-5 text-xs">
            {Object.entries(job.partialFailures).map(([agent, reason]) => (
              <li key={agent}>
                <span className="font-medium">{agent}</span>: {reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {canRetry ? (
        <div className="flex items-center justify-end gap-2">
          {retryError ? (
            <span className="text-destructive text-xs" role="alert">
              {retryError}
            </span>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void handleRetry()}
            disabled={retrying}
            data-testid={`twin-job-retry-${job.id}`}
          >
            {retrying ? t("retryBusy") : t("retry")}
          </Button>
        </div>
      ) : null}
    </Card>
  )
})
