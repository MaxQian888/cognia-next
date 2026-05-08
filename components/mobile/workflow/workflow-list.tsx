"use client"

import Link from "next/link"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { ChevronRightIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { listWorkflows } from "@/lib/db/workflows"
import { getDb } from "@/lib/db/schema"
import type { WorkflowRow, WorkflowRunRow } from "@/types/workflow/visual"
import { cn } from "@/lib/utils"

import { TriggerButton } from "./trigger-button"

export interface WorkflowListProps {
  className?: string
}

/**
 * Mobile workflow library list (Wave 3.1). One row per workflow with a
 * trigger button + an "active" badge driven by an outer Dexie liveQuery
 * over `workflowRuns` (status === "running"). Tap → navigate to the
 * desktop / mobile-shared `/workflows/[id]` detail page.
 */
export function WorkflowList({ className }: WorkflowListProps) {
  const t = useTranslations("mobile.workflow")
  const workflows = useLiveQuery<WorkflowRow[]>(() => listWorkflows(), []) ?? []
  const activeRuns =
    useLiveQuery<WorkflowRunRow[]>(
      () => getDb().workflowRuns.where("status").equals("running").toArray(),
      []
    ) ?? []

  const activeIds = new Set(activeRuns.map((r) => r.workflowId))

  return (
    <main
      className={cn("flex min-h-[100dvh] flex-col bg-background safe-area-pt", className)}
      data-testid="mobile-workflow-list"
    >
      <header className="px-4 py-3">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      </header>

      {workflows.length === 0 ? (
        <p className="px-4 text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col gap-2 px-4 pb-6">
          {workflows.map((wf) => (
            <li key={wf.id}>
              <div
                className="flex items-center gap-3 rounded-md border border-border bg-card p-3 active:bg-muted/50"
                data-testid={`workflow-row-${wf.id}`}
              >
                <Link
                  href={`/workflows/${encodeURIComponent(wf.id)}`}
                  className="flex min-w-0 flex-1 items-center gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate text-sm font-semibold">{wf.name}</h3>
                      {activeIds.has(wf.id) ? (
                        <Badge
                          variant="outline"
                          className="border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-600 dark:text-emerald-300"
                          data-testid={`workflow-active-${wf.id}`}
                        >
                          ● {t("activeBadge")}
                        </Badge>
                      ) : null}
                    </div>
                    {wf.description ? (
                      <p className="line-clamp-1 text-xs text-muted-foreground">{wf.description}</p>
                    ) : null}
                  </div>
                  <ChevronRightIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                </Link>
                <TriggerButton workflowId={wf.id} workflowName={wf.name} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
