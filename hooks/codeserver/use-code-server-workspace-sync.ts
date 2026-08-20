"use client"

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"

import { useClientLiveQuery } from "@/hooks/data"
import { codeServerClient } from "@/lib/codeserver/client"
import { buildWorkspaceSnapshot } from "@/lib/codeserver/workspace-snapshot"
import type {
  WorkspaceIssueInput,
  WorkspacePlanInput,
  WorkspaceRunInput,
} from "@/lib/codeserver/workspace-snapshot"
import { primaryFileReference } from "@/lib/issues/editor-links"
import { listIssues } from "@/lib/db/issues"
import { listAllPlans } from "@/lib/db/plans"
import { listIssueRuns } from "@/lib/db/issue-runs"
import { statusCategoryOf } from "@/types/issues"

/**
 * Keep the Pro IDE's Cognia panel in step with the user's work (ADR-0088
 * Phase 3).
 *
 * Push-only, app-decides: this reads the same Dexie tables the board and plan
 * views read, projects them through the pure
 * `buildWorkspaceSnapshot`, and hands the extension a finished picture. The
 * extension never queries back — see that module for why.
 *
 * The live queries do the change detection: `useClientLiveQuery` re-runs on any
 * write to the tables it touched, so a new issue, a plan step completing, or a
 * run settling all re-push without a polling loop.
 */
export function useCodeServerWorkspaceSync(enabled: boolean, root: string): void {
  const t = useTranslations("proIdePanel")

  const issues = useClientLiveQuery(() => listIssues({}), [], [])
  const plans = useClientLiveQuery(() => listAllPlans(), [], [])
  const runs = useClientLiveQuery(() => listIssueRuns({ activeOnly: true }), [], [])

  // Skip a push that would say exactly what the last one said. The live queries
  // re-fire on any write to the tables they touched, including ones that change
  // nothing this panel shows.
  const lastPushed = useRef<string | null>(null)

  useEffect(() => {
    if (!enabled || !root) {
      lastPushed.current = null
      return
    }

    const issueRows: WorkspaceIssueInput[] = (issues ?? []).map((issue) => {
      const reference = primaryFileReference(issue.title, issue.description)
      return {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        statusCategory: statusCategoryOf(issue.status),
        status: issue.status,
        updatedAt: issue.updatedAt,
        ...(reference ? { path: reference.path } : {}),
        ...(reference?.line !== undefined ? { line: reference.line } : {}),
      }
    })

    const planRows: WorkspacePlanInput[] = (plans ?? []).map((plan) => ({
      id: plan.id,
      title: plan.title,
      status: plan.status,
      completedSteps: plan.steps.filter((step) => step.status === "completed").length,
      totalSteps: plan.steps.length,
      updatedAt: plan.updatedAt ?? plan.createdAt ?? 0,
    }))

    const runRows: WorkspaceRunInput[] = (runs ?? []).map((run) => ({
      id: run.id,
      label: run.adapterId,
      status: run.status,
      startedAt: run.startedAt ?? 0,
    }))

    const snapshot = buildWorkspaceSnapshot({
      issues: issueRows,
      plans: planRows,
      runs: runRows,
      strings: {
        issuesTitle: t("issuesTitle"),
        plansTitle: t("plansTitle"),
        runsTitle: t("runsTitle"),
        issuesEmpty: t("issuesEmpty"),
        plansEmpty: t("plansEmpty"),
        runsEmpty: t("runsEmpty"),
        statusText: t("statusText"),
        statusTooltip: t("statusTooltip"),
        disconnected: t("disconnected"),
        noCustomActions: t("noCustomActions"),
        chooseAction: t("chooseAction"),
        noDiagnostics: t("noDiagnostics"),
      },
    })

    const serialized = JSON.stringify(snapshot)
    if (serialized === lastPushed.current) return
    lastPushed.current = serialized

    // Best-effort: the workbench may still be booting, or the companion
    // extension may not have dialled back yet. The next live-query tick pushes
    // again, and a panel that is briefly empty is a far smaller problem than a
    // render loop or a surfaced error for something the user never asked for.
    void codeServerClient.pushWorkspaceSnapshot(root, snapshot).catch(() => {
      lastPushed.current = null
    })
  }, [enabled, root, issues, plans, runs, t])
}
