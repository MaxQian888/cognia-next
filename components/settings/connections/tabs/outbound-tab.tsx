"use client"

import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { InboxIcon, RefreshCwIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Toggle } from "@/components/ui/toggle"
import { getDb } from "@/lib/db/schema"
import type { OutboundJobRow, OutboundJobStatus } from "@/lib/db/connector-types"
import { cn } from "@/lib/utils"

const ALL_STATUSES: OutboundJobStatus[] = ["pending", "sending", "sent", "failed", "deadlettered"]

type StatusFilter = OutboundJobStatus | "all"

const STATUS_VARIANT_MAP: Record<
  OutboundJobStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  pending: "secondary",
  sending: "default",
  sent: "outline",
  failed: "destructive",
  deadlettered: "destructive",
}

function StatusBadge({ status }: { status: OutboundJobStatus }) {
  return (
    <Badge
      variant={STATUS_VARIANT_MAP[status]}
      className={cn("text-xs shrink-0", {
        "text-amber-700 bg-amber-100 dark:text-amber-300 dark:bg-amber-900/30":
          status === "sending",
      })}
    >
      {status}
    </Badge>
  )
}

async function retryJob(id: string) {
  await getDb().outboundQueue.update(id, {
    status: "pending",
    nextAttemptAt: Date.now(),
  })
}

async function cancelJob(id: string) {
  await getDb().outboundQueue.delete(id)
}

interface OutboundTabProps {
  /** Injected in tests to pre-populate the filter. Defaults to "all". */
  initialFilter?: StatusFilter
}

export function OutboundTab({ initialFilter = "all" }: OutboundTabProps = {}) {
  const [filter, setFilter] = useState<StatusFilter>(initialFilter)
  // Capture render time once so we don't call Date.now() during render on every re-render
  // (satisfies react-hooks/purity). Jobs with nextAttemptAt in the future show a retry hint.
  const [now] = useState(() => Date.now())

  const allJobs = useLiveQuery<OutboundJobRow[]>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve([])
        : getDb().outboundQueue.orderBy("createdAt").reverse().toArray(),
    []
  )

  const jobs = !allJobs
    ? []
    : filter === "all"
      ? allJobs
      : allJobs.filter((j) => j.status === filter)

  return (
    <div className="space-y-4">
      {/* Status filter chips */}
      <div className="flex flex-wrap gap-1.5">
        <Toggle
          size="sm"
          pressed={filter === "all"}
          onPressedChange={() => setFilter("all")}
          aria-label="Show all"
        >
          All
        </Toggle>
        {ALL_STATUSES.map((s) => (
          <Toggle
            key={s}
            size="sm"
            pressed={filter === s}
            onPressedChange={() => setFilter(s)}
            aria-label={`Filter ${s}`}
          >
            {s}
          </Toggle>
        ))}
      </div>

      {/* Job list */}
      {jobs.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <InboxIcon className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No outbound jobs in flight.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {jobs.map((job) => (
            <div
              key={job.id}
              className="flex items-start gap-3 rounded-lg border bg-card px-4 py-3 text-sm"
            >
              <StatusBadge status={job.status} />
              <div className="flex-1 min-w-0 space-y-0.5">
                <p className="truncate font-mono text-xs">{job.conversationKey}</p>
                <p className="text-xs text-muted-foreground">
                  Adapter: {job.adapterId} · Attempts: {job.attempts}
                </p>
                {job.status === "failed" && job.nextAttemptAt > now && (
                  <p className="text-xs text-muted-foreground">
                    Next retry: {new Date(job.nextAttemptAt).toLocaleTimeString()}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {(job.status === "failed" || job.status === "deadlettered") && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => retryJob(job.id)}
                    aria-label={`Retry ${job.id}`}
                  >
                    <RefreshCwIcon className="mr-1.5 h-3.5 w-3.5" />
                    Retry
                  </Button>
                )}
                {job.status === "pending" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => cancelJob(job.id)}
                    aria-label={`Cancel ${job.id}`}
                  >
                    <XIcon className="mr-1.5 h-3.5 w-3.5" />
                    Cancel
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
