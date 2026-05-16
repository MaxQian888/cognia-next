"use client"

import Link from "next/link"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { PinIcon } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"

import { Card } from "@/components/ui/card"
import type { WorkflowRow, WorkflowRunRow } from "@/types/workflow/visual"
import { getDb } from "@/lib/db/schema"
import { STAGGER_CHILD, STAGGER_CONTAINER } from "@/lib/ui/motion"
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
  const reduce = useReducedMotion()

  if (pinned.length === 0) return null

  return (
    <section className={cn("flex flex-col gap-2 px-4", className)} data-testid="pinned-section">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t("pinned")}
      </h2>
      <motion.ul
        className="grid grid-cols-2 gap-2"
        role="list"
        data-testid="pinned-section-list"
        initial={reduce ? false : "initial"}
        animate="animate"
        variants={STAGGER_CONTAINER}
      >
        {pinned.map((wf) => (
          <motion.li key={wf.id} variants={STAGGER_CHILD}>
            <Card
              // Compact 2-col-grid card: smaller radius, no shadow.
              className="flex h-full flex-col gap-2 rounded-md p-3 py-3 shadow-none"
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
            </Card>
          </motion.li>
        ))}
      </motion.ul>
    </section>
  )
}
