"use client"

/**
 * Mobile runs list for a single workflow. The desktop `RunList` renders a
 * wide `<Table>` that horizontal-scrolls on a phone; on mobile we reuse the
 * existing `RunVerticalGantt` (a touch-friendly vertical run list) inside the
 * standard mobile sub-page shell instead.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"

import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { getDb } from "@/lib/db/schema"
import type { WorkflowRunRow } from "@/types/workflow/visual"

import { RunVerticalGantt } from "./run-vertical-gantt"

export interface MobileRunsListProps {
  workflowId: string
}

export function MobileRunsList({ workflowId }: MobileRunsListProps) {
  const t = useTranslations("mobile.workflow")
  // `startedAt` is indexed (see recent-runs-feed); filter by workflow id in JS
  // so we don't depend on a `workflowId` index existing on the table.
  const allRuns = useLiveQuery<WorkflowRunRow[]>(
    () => getDb().workflowRuns.orderBy("startedAt").reverse().toArray(),
    []
  )
  const runs = useMemo(
    () => (allRuns ?? []).filter((r) => r.workflowId === workflowId),
    [allRuns, workflowId]
  )

  return (
    <SubPageShell
      title={t("runsHeader")}
      backAria={t("runsBackAria")}
      backHref={`/workflows/editor?id=${encodeURIComponent(workflowId)}`}
      testid="mobile-runs-list"
    >
      <RunVerticalGantt runs={runs} className="rounded-md border border-border bg-card" />
    </SubPageShell>
  )
}
