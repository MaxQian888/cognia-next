"use client"

/**
 * Compact "active runs" card for the mobile home (chat welcome). Surfaces
 * currently-running workflows so the home doubles as a lightweight monitor.
 *
 * Self-hides when there are no running workflows (keeping the welcome minimal)
 * and obeys the `activeRuns` home section toggle (`useMobileHomeLayout`). Tapping
 * the card jumps to the most-recent active run's runs view; the dismiss control
 * beside it turns the section off for good, and the home-layout sheet (app bar
 * overflow menu) turns it back on.
 */

import { useMemo } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { ChevronRightIcon, LoaderIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { getDb } from "@/lib/db/schema"
import { listWorkflows } from "@/lib/db/workflows"
import type { WorkflowRow, WorkflowRunRow } from "@/types/workflow/visual"
import { cn } from "@/lib/utils"
import { useMobileHomeLayout } from "./use-mobile-home-layout"

export interface MobileActiveRunsCardProps {
  className?: string
}

export function MobileActiveRunsCard({ className }: MobileActiveRunsCardProps) {
  const t = useTranslations("mobile.home.activeRuns")
  const tHome = useTranslations("mobile.home")
  const tSections = useTranslations("mobile.home.sections")
  const { isSectionHidden, hideSection } = useMobileHomeLayout()

  const runsRaw = useLiveQuery<WorkflowRunRow[]>(
    () => getDb().workflowRuns.where("status").equals("running").toArray(),
    []
  )
  const workflowsRaw = useLiveQuery<WorkflowRow[]>(() => listWorkflows(), [])

  const runs = useMemo(
    () => [...(runsRaw ?? [])].sort((a, b) => b.startedAt - a.startedAt),
    [runsRaw]
  )
  const nameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const wf of workflowsRaw ?? []) map.set(wf.id, wf.name)
    return map
  }, [workflowsRaw])

  // Section toggled off, or nothing running → render nothing.
  if (isSectionHidden("activeRuns") || runs.length === 0) return null

  const latest = runs[0]
  const latestName = nameById.get(latest.workflowId) ?? latest.workflowId

  return (
    // The dismiss sits OUTSIDE the <Link>, not inside it: a button nested in an
    // anchor is invalid markup, and the tap would have to fight the link's own
    // navigation with stopPropagation on every platform.
    <Card
      className={cn(
        "flex flex-row items-center gap-1 rounded-md border-emerald-500/30 bg-emerald-500/5 p-0 pe-1 shadow-none",
        className
      )}
    >
      <Link
        href={`/workflows/runs?id=${encodeURIComponent(latest.workflowId)}`}
        data-testid="mobile-active-runs-card"
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md p-3 transition-colors active:bg-emerald-500/10"
      >
        <LoaderIcon
          className="size-4 shrink-0 animate-spin text-emerald-600 dark:text-emerald-400"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-emerald-700 dark:text-emerald-300">
            {t("title", { count: runs.length })}
          </p>
          <p className="truncate text-xs text-muted-foreground">{latestName}</p>
        </div>
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </Link>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 text-muted-foreground/70 hover:text-foreground"
        aria-label={tHome("hideSection", { section: tSections("activeRuns") })}
        onClick={() => void hideSection("activeRuns")}
        data-testid="mobile-active-runs-dismiss"
      >
        <XIcon className="size-3.5" aria-hidden="true" />
      </Button>
    </Card>
  )
}
