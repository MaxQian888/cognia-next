"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { ChevronRightIcon, FolderIcon } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { EmptyState } from "@/components/mobile/empty-state"
import { LongPress } from "@/components/interactions/long-press"
import { PullToRefresh } from "@/components/interactions/pull-to-refresh"
import { SwipeRow } from "@/components/interactions/swipe-row"
import { enqueue as enqueueOutbound } from "@/lib/db/mobile-outbound-queue"
import { listChildFolders, getFolderPath } from "@/lib/db/workflow-folders"
import {
  getRecentlyFailedWorkflowIds,
  getRunCounts,
  listWorkflowsInFolder,
} from "@/lib/db/workflows"
import { getDb } from "@/lib/db/schema"
import { runSyncDown } from "@/lib/sync/companion-sync"
import { filterWorkflows, sortWorkflows } from "@/lib/workflow/library-filter"
import { ROOT_FOLDER_ID } from "@/types/workflow/folder"
import { STAGGER_CHILD, STAGGER_CONTAINER } from "@/lib/ui/motion"
import { useSettingsStore } from "@/stores/settings"
import { useWorkflowLibraryStore } from "@/stores/workflow"
import type { WorkflowRow, WorkflowRunRow } from "@/types/workflow/visual"
import { cn } from "@/lib/utils"

import { WorkflowCreateDialog } from "@/components/workflow/library/workflow-create-dialog"
import { WorkflowCreateFolderDialog } from "@/components/workflow/library/workflow-create-folder-dialog"
import { WorkflowFolderBreadcrumb } from "@/components/workflow/library/workflow-folder-breadcrumb"
import { PendingApprovalsCard } from "./pending-approvals-card"
import { PinnedSection } from "./pinned-section"
import { RecentRunsFeed } from "./recent-runs-feed"
import { TriggerButton } from "./trigger-button"
import { usePendingWorkflowTriggers } from "./use-pending-triggers"
import { WorkflowListToolbar } from "./workflow-list-toolbar"
import { WorkflowRowActionsSheet } from "./workflow-row-actions-sheet"
import { useMobileWorkflowView } from "./use-mobile-workflow-view"

export interface WorkflowListProps {
  className?: string
}

const RECENTLY_FAILED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const EMPTY_FAILED_IDS: ReadonlySet<string> = new Set<string>()
const EMPTY_RUN_COUNTS: ReadonlyMap<string, number> = new Map<string, number>()

/**
 * Mobile workflow library list. Now folder-aware and filterable: it reuses the
 * desktop `useWorkflowLibraryStore` slice (query / sort / filters / folder) and
 * the pure `filterWorkflows` / `sortWorkflows` helpers, so the mobile surface
 * stays in lock-step with the desktop library without a parallel state layer.
 *
 * Layout: toolbar → breadcrumb (in a sub-folder) → pinned grid (root only) →
 * child folders + workflow rows → recent runs feed.
 */
export function WorkflowList({ className }: WorkflowListProps) {
  const t = useTranslations("mobile.workflow")

  const currentFolderId = useWorkflowLibraryStore((s) => s.currentFolderId)
  const sort = useWorkflowLibraryStore((s) => s.sort)
  const filters = useWorkflowLibraryStore((s) => s.filters)
  const query = useWorkflowLibraryStore((s) => s.query)
  const enterFolder = useWorkflowLibraryStore((s) => s.enterFolder)
  const goToRoot = useWorkflowLibraryStore((s) => s.goToRoot)

  const childFolders = useLiveQuery(() => listChildFolders(currentFolderId), [currentFolderId])
  const folderPath = useLiveQuery(() => getFolderPath(currentFolderId), [currentFolderId])
  const folderWorkflows = useLiveQuery(
    () => listWorkflowsInFolder(currentFolderId),
    [currentFolderId]
  )
  const recentlyFailedIds = useLiveQuery(
    () =>
      filters.recentlyFailed
        ? getRecentlyFailedWorkflowIds(Date.now() - RECENTLY_FAILED_WINDOW_MS)
        : Promise.resolve(EMPTY_FAILED_IDS as Set<string>),
    [filters.recentlyFailed]
  )
  const runCounts = useLiveQuery(
    () =>
      sort === "runCount" && folderWorkflows
        ? getRunCounts(folderWorkflows.map((w) => w.id))
        : Promise.resolve(EMPTY_RUN_COUNTS as Map<string, number>),
    [sort, folderWorkflows]
  )
  const activeRuns =
    useLiveQuery<WorkflowRunRow[]>(
      () => getDb().workflowRuns.where("status").equals("running").toArray(),
      []
    ) ?? []
  // Manual triggers tapped on this device live in the outbound queue until the
  // desktop runs them and the run row syncs back — surface them so the list
  // reflects the "sending" state instead of looking inert after a tap.
  const pendingTriggerIds = usePendingWorkflowTriggers()

  const visible = useMemo(() => {
    if (!folderWorkflows) return undefined
    const failed = recentlyFailedIds ?? EMPTY_FAILED_IDS
    const counts = runCounts ?? EMPTY_RUN_COUNTS
    const filtered = filterWorkflows(folderWorkflows, {
      query,
      filters,
      recentlyFailedIds: failed as Set<string>,
    })
    return sortWorkflows(filtered, sort, counts as Map<string, number>)
  }, [folderWorkflows, query, filters, recentlyFailedIds, sort, runCounts])

  // Folder removed elsewhere — never strand the user inside it.
  useEffect(() => {
    if (currentFolderId !== ROOT_FOLDER_ID && folderPath !== undefined && folderPath.length === 0) {
      goToRoot()
    }
  }, [currentFolderId, folderPath, goToRoot])

  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const pinnedIds = settings?.pinnedWorkflowIds ?? []
  const { view } = useMobileWorkflowView()
  const reduce = useReducedMotion()

  const [createOpen, setCreateOpen] = useState(false)
  const [actionSheetWorkflow, setActionSheetWorkflow] = useState<WorkflowRow | null>(null)

  const togglePin = async (id: string, name: string) => {
    const next = pinnedIds.includes(id) ? pinnedIds.filter((p) => p !== id) : [...pinnedIds, id]
    await save({ pinnedWorkflowIds: next })
    toast.success(pinnedIds.includes(id) ? t("pinned_removed") : t("pinned_added"))
    void name
  }

  const handleRefresh = async (): Promise<void> => {
    try {
      // This screen renders workflows + their run state (active/sending
      // badges, recent-runs feed) — pull both, but not the other eight tables.
      await runSyncDown({ only: ["workflows", "workflowRuns"] })
    } catch {
      // Orchestrator swallows handler-level failures; nothing more to do.
    }
  }

  const activeIds = new Set(activeRuns.map((r) => r.workflowId))
  const atRoot = currentFolderId === ROOT_FOLDER_ID
  const compact = view === "compact"
  const rows = visible ?? []
  const folders = childFolders ?? []
  const isEmpty = rows.length === 0 && folders.length === 0

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

      <WorkflowListToolbar onNewWorkflow={() => setCreateOpen(true)} />

      {!atRoot ? (
        <div className="px-4 text-sm" data-testid="mobile-workflow-breadcrumb">
          <WorkflowFolderBreadcrumb path={folderPath ?? []} />
        </div>
      ) : null}

      {/* HITL gates blocked on a human decision (ADR 0061 P2) — surfaced
          above everything else because a run is actively waiting. */}
      {atRoot ? <PendingApprovalsCard className="mx-4" /> : null}

      {atRoot ? <PinnedSection workflows={rows} pinnedIds={pinnedIds} /> : null}

      <PullToRefresh onRefresh={handleRefresh}>
        <section className="flex flex-col gap-2 px-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("all")}
          </h2>

          {/* Child folders (tap to enter). */}
          {folders.length > 0 ? (
            <ul className="flex flex-col gap-2" data-testid="mobile-workflow-folders">
              {folders.map((folder) => (
                <li key={folder.id}>
                  <Card
                    role="button"
                    tabIndex={0}
                    onClick={() => enterFolder(folder.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault()
                        enterFolder(folder.id)
                      }
                    }}
                    data-testid={`mobile-workflow-folder-${folder.id}`}
                    className={cn(
                      "flex cursor-pointer flex-row items-center gap-3 rounded-md shadow-none transition-colors active:bg-muted/50",
                      compact ? "p-2" : "p-3"
                    )}
                  >
                    <FolderIcon className="size-5 shrink-0 text-primary" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {folder.name}
                    </span>
                    <ChevronRightIcon
                      className="size-4 text-muted-foreground"
                      aria-hidden="true"
                    />
                  </Card>
                </li>
              ))}
            </ul>
          ) : null}

          {isEmpty ? (
            <EmptyState spotIcon="workflows" title={t("empty")} />
          ) : (
            <motion.ul
              className="flex flex-col gap-2"
              initial={reduce ? false : "initial"}
              animate="animate"
              variants={STAGGER_CONTAINER}
            >
              {rows.map((wf) => (
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
                        className={cn(
                          "flex flex-row items-center gap-3 rounded-md shadow-none transition-colors active:bg-muted/50",
                          compact ? "p-2" : "p-3 py-3"
                        )}
                        data-testid={`workflow-row-${wf.id}`}
                      >
                        <Link
                          href={`/workflows/editor?id=${encodeURIComponent(wf.id)}`}
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
                              ) : pendingTriggerIds.has(wf.id) ? (
                                <Badge
                                  variant="outline"
                                  className="border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-600 dark:text-amber-300"
                                  data-testid={`workflow-sending-${wf.id}`}
                                >
                                  ● {t("sending")}
                                </Badge>
                              ) : null}
                            </div>
                            {!compact && wf.description ? (
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

      {atRoot ? <RecentRunsFeed /> : null}

      <WorkflowCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        parentFolderId={currentFolderId}
      />
      <WorkflowCreateFolderDialog />

      <WorkflowRowActionsSheet
        workflow={actionSheetWorkflow}
        onOpenChange={(open) => {
          if (!open) setActionSheetWorkflow(null)
        }}
      />
    </main>
  )
}
