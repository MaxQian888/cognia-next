"use client"

import Link from "next/link"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { PinIcon } from "lucide-react"

import type { WorkflowRow, WorkflowRunRow } from "@/types/workflow/visual"
import { getDb } from "@/lib/db/schema"
import { cn } from "@/lib/utils"

import { TriggerButton } from "./trigger-button"

export interface PinnedSectionProps {
  workflows: WorkflowRow[]
  pinnedIds: string[]
  className?: string
}

export function PinnedSection({ workflows, pinnedIds, className }: PinnedSectionProps) {
  const t = useTranslations("mobile.workflow")
  const pinned = workflows.filter((w) => pinnedIds.includes(w.id))
  const activeRuns =
    useLiveQuery<WorkflowRunRow[]>(
      () => getDb().workflowRuns.where("status").equals("running").toArray(),
      []
    ) ?? []
  const activeIds = new Set(activeRuns.map((r) => r.workflowId))

  if (pinned.length === 0) return null

  return (
    <section className={cn("flex flex-col gap-2 px-4", className)} data-testid="pinned-section">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t("pinned")}
      </h2>
      <ul className="grid grid-cols-2 gap-2" role="list" data-testid="pinned-section-list">
        {pinned.map((wf) => (
          <li key={wf.id}>
            <div
              className="flex h-full flex-col gap-2 rounded-md border border-border bg-card p-3"
              data-testid={`pinned-card-${wf.id}`}
            >
              <Link
                href={`/workflows/${encodeURIComponent(wf.id)}`}
                className="flex flex-1 flex-col gap-1"
              >
                <span className="flex items-center gap-1">
                  <PinIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="line-clamp-1 text-sm font-semibold">{wf.name}</span>
                </span>
                {activeIds.has(wf.id) ? (
                  <span
                    data-testid={`pinned-active-${wf.id}`}
                    className="inline-flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-300"
                  >
                    <span className="size-1.5 rounded-full bg-emerald-500" />
                    {t("activeBadge")}
                  </span>
                ) : null}
              </Link>
              <TriggerButton workflowId={wf.id} workflowName={wf.name} className="w-full" />
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
