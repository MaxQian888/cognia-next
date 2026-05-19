"use client"

import { useState } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { useDexieFirstQuery } from "@/hooks/data"
import { ChevronRightIcon, WorkflowIcon } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { EmptyState } from "@/components/mobile/empty-state"
import { LongPress } from "@/components/interactions/long-press"
import { PullToRefresh } from "@/components/interactions/pull-to-refresh"
import { SwipeRow } from "@/components/interactions/swipe-row"
import { enqueue as enqueueOutbound } from "@/lib/db/mobile-outbound-queue"
import { listWorkflows } from "@/lib/db/workflows"
import { getDb } from "@/lib/db/schema"
import { runSyncDown } from "@/lib/sync/companion-sync"
import { STAGGER_CHILD, STAGGER_CONTAINER } from "@/lib/ui/motion"
import { useSettingsStore } from "@/stores/settings"
import type { WorkflowRow, WorkflowRunRow } from "@/types/workflow/visual"
import { cn } from "@/lib/utils"

import { PinnedSection } from "./pinned-section"
import { RecentRunsFeed } from "./recent-runs-feed"
import { TriggerButton } from "./trigger-button"
import { WorkflowRowActionsSheet } from "./workflow-row-actions-sheet"

export interface WorkflowListProps {
  className?: string
}

/**
 * Mobile workflow library list (Wave 3.1, refined Wave 3.6). One row per
 * workflow with a trigger button + an "active" badge driven by an outer
 * Dexie liveQuery over `workflowRuns` (status === "running"). Tap →
 * navigate to `/workflows/[id]`. Long-press → toggle pin.
 *
 * Layout:
 *   - Pinned grid (when any are pinned)
 *   - All workflows list
 *   - Recent runs feed
 */
export function WorkflowList({ className }: WorkflowListProps) {
  const t = useTranslations("mobile.workflow")
  // Wave 4 / ADR-0026 — Dexie-first read so the list survives a server
  // drop; `table: "workflows"` kicks the sync orchestrator on mount.
  const workflows =
    useDexieFirstQuery<WorkflowRow[]>({
      query: () => listWorkflows(),
      deps: [],
      initial: [],
      table: "workflows",
    }).data ?? []
  const activeRuns =
    useLiveQuery<WorkflowRunRow[]>(
      () => getDb().workflowRuns.where("status").equals("running").toArray(),
      []
    ) ?? []

  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const pinnedIds = settings?.pinnedWorkflowIds ?? []
  const reduce = useReducedMotion()

  const togglePin = async (id: string, name: string) => {
    const next = pinnedIds.includes(id) ? pinnedIds.filter((p) => p !== id) : [...pinnedIds, id]
    await save({ pinnedWorkflowIds: next })
    toast.success(pinnedIds.includes(id) ? t("pinned_removed") : t("pinned_added"))
    void name
  }

  // Wave 4 / ADR-0026 — action sheet driven by long-press on each row;
  // null when no row is targeted.
  const [actionSheetWorkflow, setActionSheetWorkflow] = useState<WorkflowRow | null>(null)

  // Pull-to-refresh: kick the sync orchestrator so workflows + runs reload.
  const handleRefresh = async (): Promise<void> => {
    try {
      await runSyncDown()
    } catch {
      // Orchestrator swallows handler-level failures; nothing more to do.
    }
  }

  const activeIds = new Set(activeRuns.map((r) => r.workflowId))

  return (
    <main
      className={cn(
        "flex min-h-[100dvh] flex-col gap-4 bg-background pt-3 safe-area-pt",
        className
      )}
      data-testid="mobile-workflow-list"
    >
      <header className="px-4">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      </header>

      <PinnedSection workflows={workflows} pinnedIds={pinnedIds} />

      <PullToRefresh onRefresh={handleRefresh}>
        <section className="flex flex-col gap-2 px-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("all")}
          </h2>
          {workflows.length === 0 ? (
            <EmptyState icon={WorkflowIcon} title={t("empty")} />
          ) : (
            <motion.ul
              className="flex flex-col gap-2"
              initial={reduce ? false : "initial"}
              animate="animate"
              variants={STAGGER_CONTAINER}
            >
              {workflows.map((wf) => (
                <motion.li key={wf.id} variants={STAGGER_CHILD}>
                  <SwipeRow
                    rightActions={[
                      {
                        id: "run",
                        label: t("swipe.run"),
                        onSelect: () => {
                          void enqueueOutbound({
                            command: "workflow_trigger_manual",
                            payload: { workflowId: wf.id },
                          }).then(() => toast.success(t("swipe.runQueued", { name: wf.name })))
                        },
                      },
                      {
                        id: "pin",
                        label: pinnedIds.includes(wf.id)
                          ? t("swipe.unfavorite")
                          : t("swipe.favorite"),
                        onSelect: () => void togglePin(wf.id, wf.name),
                      },
                    ]}
                  >
                    <LongPress onLongPress={() => setActionSheetWorkflow(wf)}>
                      <Card
                        // Compact mobile-row treatment: tighter padding/radius +
                        // shadow-none + horizontal flex (Card defaults to col).
                        className="flex flex-row items-center gap-3 rounded-md p-3 py-3 shadow-none transition-colors active:bg-muted/50"
                        data-testid={`workflow-row-${wf.id}`}
                      >
                        <Link
                          href={`/workflows/${encodeURIComponent(wf.id)}`}
                          className="flex min-w-0 flex-1 items-center gap-3"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <h3 className="truncate text-sm font-semibold">{wf.name}</h3>
                              {pinnedIds.includes(wf.id) ? (
                                <Badge
                                  variant="outline"
                                  className="text-[10px]"
                                  data-testid={`workflow-pinned-${wf.id}`}
                                >
                                  {t("pinned")}
                                </Badge>
                              ) : null}
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
                              <p className="line-clamp-1 text-xs text-muted-foreground">
                                {wf.description}
                              </p>
                            ) : null}
                          </div>
                          <ChevronRightIcon
                            className="size-4 text-muted-foreground"
                            aria-hidden="true"
                          />
                        </Link>
                        <TriggerButton workflowId={wf.id} workflowName={wf.name} />
                      </Card>
                    </LongPress>
                  </SwipeRow>
                </motion.li>
              ))}
            </motion.ul>
          )}
        </section>
      </PullToRefresh>

      <RecentRunsFeed />

      <WorkflowRowActionsSheet
        workflow={actionSheetWorkflow}
        onOpenChange={(open) => {
          if (!open) setActionSheetWorkflow(null)
        }}
      />
    </main>
  )
}
