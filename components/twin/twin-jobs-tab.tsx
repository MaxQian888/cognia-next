"use client"

import { useLiveQuery } from "dexie-react-hooks"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Button } from "@/components/ui/button"
import { listTwinJobsByTwin } from "@/lib/db/twin-jobs"
import { listTwinSourcesByTwinAndStatus } from "@/lib/db/twin-sources"
import { enqueueIngestJob } from "@/lib/twin/ingest"
import { enqueueDistillJob } from "@/lib/twin/distill"
import type { TwinJob, TwinJobStatus } from "@/types/twin"

const STATUS_VARIANT: Record<TwinJobStatus, "default" | "secondary" | "destructive" | "outline"> = {
  queued: "outline",
  running: "secondary",
  paused: "outline",
  completed: "default",
  failed: "destructive",
}

export function TwinJobsTab({ twinId }: { twinId: string }) {
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
        <h2 className="text-lg font-medium">Jobs ({jobs.length})</h2>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => void queueIngest()}>
            Queue ingest for pending sources
          </Button>
          <Button size="sm" onClick={() => void queueDistill()}>
            Queue distill
          </Button>
        </div>
      </div>

      {jobs.length === 0 ? (
        <Card className="p-6 text-center">
          <p className="text-muted-foreground text-sm">
            No jobs yet. Add sources, then queue an ingest run; queue a distill once the chunks are
            indexed.
          </p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {jobs.map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
        </ul>
      )}
    </div>
  )
}

function JobRow({ job }: { job: TwinJob }) {
  return (
    <Card className="flex flex-col gap-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={STATUS_VARIANT[job.status]} className="capitalize">
            {job.status}
          </Badge>
          <Badge variant="outline" className="capitalize">
            {job.kind}
          </Badge>
          <span className="text-sm font-medium">{job.phase}</span>
        </div>
        <span className="text-muted-foreground text-xs">
          queued {new Date(job.queuedAt).toLocaleString()}
        </span>
      </div>
      <Progress value={job.progress} max={100} />
      {job.errorMessage ? <p className="text-destructive text-xs">⚠ {job.errorMessage}</p> : null}
      {job.outputDraftIds && job.outputDraftIds.length > 0 ? (
        <p className="text-muted-foreground text-xs">
          {job.outputDraftIds.length} draft{job.outputDraftIds.length === 1 ? "" : "s"} produced
        </p>
      ) : null}
    </Card>
  )
}
