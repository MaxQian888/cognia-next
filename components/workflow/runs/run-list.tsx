"use client"

/**
 * Per-workflow runs list. Reads `workflowRuns` for a given `workflowId`,
 * sorts newest-first, and surfaces each run as a clickable row that links
 * into the timeline detail page.
 */

import { useLiveQuery } from "dexie-react-hooks"
import Link from "next/link"
import { ArrowLeftIcon, ChevronRightIcon, PlayCircleIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { getDb } from "@/lib/db/schema"
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
import { RunStatusPill } from "./run-status-pill"
import { formatRunDuration, formatRunStartedAt } from "./format"

export function RunList({ workflowId }: { workflowId: string }) {
  const t = useTranslations("workflows.runs.list")
  const runs = useLiveQuery(
    async () =>
      getDb()
        .workflowRuns.where("[workflowId+startedAt]")
        .between([workflowId, 0], [workflowId, Number.MAX_SAFE_INTEGER])
        .reverse()
        .toArray(),
    [workflowId]
  )

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b px-6 py-4">
        <Button asChild size="icon" variant="ghost" aria-label={t("backToEditor")}>
          <Link href={`/workflows/editor?id=${encodeURIComponent(workflowId)}`}>
            <ArrowLeftIcon className="size-4" />
          </Link>
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-semibold leading-tight">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {runs === undefined ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : runs.length === 0 ? (
          <Empty className="mx-auto max-w-md py-12">
            <EmptyHeader>
              <EmptyMedia>
                <PlayCircleIcon className="size-8" aria-hidden="true" />
              </EmptyMedia>
            </EmptyHeader>
            <EmptyTitle>{t("empty.title")}</EmptyTitle>
            <EmptyDescription>
              {t.rich("empty.description", {
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </EmptyDescription>
          </Empty>
        ) : (
          <div className="rounded-md border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.status")}</TableHead>
                  <TableHead>{t("columns.trigger")}</TableHead>
                  <TableHead>{t("columns.started")}</TableHead>
                  <TableHead>{t("columns.duration")}</TableHead>
                  <TableHead className="w-12" aria-label={t("columns.open")} />
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell>
                      <RunStatusPill status={run.status} />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground font-mono">
                      {run.triggerKind}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatRunStartedAt(run.startedAt)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground tabular-nums">
                      {formatRunDuration(run)}
                    </TableCell>
                    <TableCell>
                      <Button asChild variant="ghost" size="icon" className="size-8">
                        <Link
                          href={`/workflows/run?id=${encodeURIComponent(workflowId)}&runId=${encodeURIComponent(run.id)}`}
                          aria-label={t("openRun", { id: run.id })}
                        >
                          <ChevronRightIcon className="size-4" />
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  )
}
