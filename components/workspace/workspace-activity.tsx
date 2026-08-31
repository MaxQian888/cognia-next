"use client"

/**
 * What is happening in this workspace — ADR-0149 §6, Batch 7c.
 *
 * # Why plans and runs share one panel
 *
 * They answer the same question from two directions: a plan is the work
 * somebody intends, a run is the work an engine is doing. Split across two
 * panels a reader has to correlate them by eye; together, "Migrate the store ·
 * executing · 1/3" sits beside "Fix the flake · running · Ada" and the
 * workspace's state reads in one glance.
 *
 * # Reads the mirror, never the network
 *
 * `lib/collab/refresh.ts` owns fetching, exactly as the members panel does.
 * Opening the tab never blocks, and an unreachable server degrades to
 * stale-but-visible rather than empty.
 *
 * # What is deliberately not here
 *
 * A plan's steps. The mirror holds headers only (see
 * `lib/db/collab-plan-mirror-types.ts`), so this renders progress as counts.
 * The day a plan detail view lands, the steps and this panel's row grow
 * together — building the row for steps that are not pulled would be a
 * placeholder that never fills.
 */

import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { ActivityIcon, ExternalLinkIcon } from "lucide-react"

import { CollabRefreshStaleBadge } from "@/components/issues/collab-refresh-stale-badge"
import { ConsoleSection } from "@/components/surface/console-section"
import { Badge } from "@/components/ui/badge"
import { listCollabPlans } from "@/lib/db/collab-plan-mirror"
import type { CollabPlanMirrorRow } from "@/lib/db/collab-plan-mirror-types"
import { listCollabRuns } from "@/lib/db/collab-run-mirror"
import type { CollabRunMirrorRow } from "@/lib/db/collab-run-mirror-types"
import { PLAN_STATUS_VARIANT, RUN_STATUS_VARIANT } from "./workspace-activity-catalogue"

/**
 * Which badge a status gets.
 *
 * Table-driven rather than nested ternaries so a status added to either union
 * is a missing key TypeScript points at, instead of silently taking whatever
 * the final `else` branch was.
 */
export function WorkspaceActivity({ workspaceId }: { workspaceId: string | null }) {
  const t = useTranslations("workspace.activity")

  const plans =
    useLiveQuery<CollabPlanMirrorRow[]>(
      () =>
        typeof window === "undefined" || !workspaceId
          ? Promise.resolve([])
          : listCollabPlans({ workspaceId }),
      [workspaceId]
    ) ?? []

  const runs =
    useLiveQuery<CollabRunMirrorRow[]>(
      () =>
        typeof window === "undefined" || !workspaceId
          ? Promise.resolve([])
          : listCollabRuns({ workspaceId }),
      [workspaceId]
    ) ?? []

  if (!workspaceId) return null

  const empty = plans.length === 0 && runs.length === 0

  return (
    <ConsoleSection
      id="activity"
      pane="workspace-pane"
      idPrefix="workspace-section"
      icon={ActivityIcon}
      title={t("title")}
      meta={
        // Same honesty the roster carries: this reads a mirror, so it has to
        // say when the mirror is behind.
        <span className="flex items-center gap-1.5">
          <CollabRefreshStaleBadge />
          <span className="tabular-nums">{plans.length + runs.length}</span>
        </span>
      }
    >
      <div className="flex flex-col gap-2" data-testid="workspace-activity">
        {empty ? (
          // Not an error. A workspace nobody shares work in is the ordinary case,
          // and a failure-shaped message would make a working app look broken.
          <p
            className="text-xs text-muted-foreground italic"
            data-testid="workspace-activity-empty"
          >
            {t("empty")}
          </p>
        ) : (
          <div className="space-y-3">
            {plans.length > 0 ? (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">{t("plans")}</p>
                <ul className="space-y-1.5">
                  {plans.map((plan) => (
                    <li
                      key={plan.id}
                      className="flex items-center justify-between gap-2 text-xs"
                      data-testid={`workspace-activity-plan-${plan.id}`}
                    >
                      <span className="flex min-w-0 shrink flex-col">
                        <span className="truncate" title={plan.title}>
                          {plan.title}
                        </span>
                        <span className="text-muted-foreground">
                          {plan.totalSteps === 0
                            ? t("noSteps")
                            : t("progress", {
                                completed: plan.completedSteps,
                                total: plan.totalSteps,
                              })}
                        </span>
                      </span>
                      <Badge
                        variant={PLAN_STATUS_VARIANT[plan.status]}
                        aria-label={t("planStatusAria")}
                        className="shrink-0"
                      >
                        {t(`planStatus.${plan.status}`)}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {runs.length > 0 ? (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">{t("runs")}</p>
                <ul className="space-y-1.5">
                  {runs.map((run) => (
                    <li
                      key={run.id}
                      className="flex items-center justify-between gap-2 text-xs"
                      data-testid={`workspace-activity-run-${run.id}`}
                    >
                      <span className="flex min-w-0 shrink flex-col">
                        <span className="truncate" title={run.title}>
                          {run.title}
                        </span>
                        <span className="text-muted-foreground">
                          {/*
                          Falls back to the raw `usr_` id rather than a
                          placeholder word — an id somebody can search for beats
                          "unknown person", the same call the roster makes.
                        */}
                          {t("startedBy", { name: run.startedBy.label ?? run.startedBy.id })}
                          {" · "}
                          {t(`runKind.${run.kind}`)}
                        </span>
                        {run.artifacts.length > 0 ? (
                          <span
                            className="flex flex-wrap gap-2 pt-0.5"
                            aria-label={t("artifactsAria")}
                          >
                            {run.artifacts.map((artifact) => (
                              <a
                                key={artifact.href}
                                href={artifact.href}
                                target="_blank"
                                rel="noreferrer noopener"
                                className="inline-flex items-center gap-1 text-primary hover:underline"
                              >
                                <ExternalLinkIcon className="size-3" aria-hidden="true" />
                                <span className="truncate">{artifact.label}</span>
                              </a>
                            ))}
                          </span>
                        ) : null}
                      </span>
                      <Badge
                        variant={RUN_STATUS_VARIANT[run.status]}
                        aria-label={t("runStatusAria")}
                        className="shrink-0"
                      >
                        {t(`runStatus.${run.status}`)}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </ConsoleSection>
  )
}
