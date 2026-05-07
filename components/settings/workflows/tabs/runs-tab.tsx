"use client"

import { useLiveQuery } from "dexie-react-hooks"
import Link from "next/link"
import { PlayCircleIcon, ChevronRightIcon } from "lucide-react"
import { getDb } from "@/lib/db/schema"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import type { RunStatus, WorkflowRunRow } from "@/types/workflow/visual"
import { cn } from "@/lib/utils"

const STATUS_STYLE: Record<RunStatus, string> = {
  pending: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-300",
  running: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  waiting: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  paused: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  succeeded: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  failed: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  cancelled: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400",
}

export function RunsTab() {
  const runs = useLiveQuery(
    async () => getDb().workflowRuns.orderBy("startedAt").reverse().limit(50).toArray(),
    []
  )

  if (runs === undefined) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    )
  }

  if (runs.length === 0) {
    return (
      <Empty className="mx-auto max-w-md py-12">
        <EmptyHeader>
          <EmptyMedia>
            <PlayCircleIcon className="size-8" aria-hidden="true" />
          </EmptyMedia>
        </EmptyHeader>
        <EmptyTitle>No runs yet</EmptyTitle>
        <EmptyDescription>
          Runs will appear here as soon as workflows start firing — manually, on a schedule, or in
          response to platform events.
        </EmptyDescription>
      </Empty>
    )
  }

  return (
    <div className="rounded-md border overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Workflow</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Trigger</TableHead>
            <TableHead>Started</TableHead>
            <TableHead className="w-12" aria-label="Open" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((run) => (
            <RunRow key={run.id} run={run} />
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function RunRow({ run }: { run: WorkflowRunRow }) {
  return (
    <TableRow>
      <TableCell className="font-medium">{run.workflowSnapshot.name}</TableCell>
      <TableCell>
        <Badge variant="outline" className={cn("font-normal", STATUS_STYLE[run.status])}>
          {run.status}
        </Badge>
      </TableCell>
      <TableCell className="text-muted-foreground text-xs">{run.triggerKind}</TableCell>
      <TableCell className="text-muted-foreground text-xs">
        {new Date(run.startedAt).toLocaleString()}
      </TableCell>
      <TableCell>
        <Button variant="ghost" size="icon" className="size-8" asChild>
          <Link href={`/workflows/${run.workflowId}/runs/${run.id}`}>
            <ChevronRightIcon className="size-4" />
          </Link>
        </Button>
      </TableCell>
    </TableRow>
  )
}
