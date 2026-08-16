"use client"

/**
 * The `/issues` surface — the total board.
 *
 * Reads through the `IssueSourceRegistry`, not straight from Dexie, so the
 * GitHub mirror and agent-task sources (slices ② / ③) light up by registering
 * an adapter with no change here. Reactivity comes from a Dexie live query on
 * the local table: any local write re-emits, which re-runs the registry
 * fan-out. Federated sources refresh on their own cadence (a scheduler
 * executor, for GitHub) and are picked up by the same fan-out.
 *
 * Layout is `FeaturePageShell` — the repo's existing 3-pane feature shell —
 * so the board sits in the centre with a properties inspector on the right and
 * degrades to a Sheet below `md` for free.
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"

import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useClientLiveQuery } from "@/hooks/data"
import { listIssues } from "@/lib/db/issues"
import { listIssueProjects } from "@/lib/db/issue-projects"
import { listLabels } from "@/lib/db/labels"
import {
  applyIssueFilter,
  buildIssueGroups,
  EMPTY_ISSUE_FILTER,
  issueRunHint,
  type IssueBoardFilter,
  type IssueGroupBy,
} from "@/lib/issues/board-model"
import { getIssueSourceRegistry } from "@/lib/issues/sources/registry"
import { runWorkspaceGithubSync } from "@/lib/issues/sync-runner"
import {
  applyIssueSort,
  applyViewScope,
  BUILTIN_ISSUE_VIEWS,
  DEFAULT_ISSUE_VIEW_ID,
  findIssueView,
  type IssueSortMode,
  type IssueViewLayout,
  type IssueViewerContext,
} from "@/lib/issues/views"
import { useProjectStore } from "@/stores/project/project-store"
import type { IssueStatus } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { parseUnifiedIssueId } from "@/types/issues/unified"
import type { LabelRow } from "@/types/labels"
import { moveIssue, reorderIssues } from "@/lib/db/issues"
import {
  buildIssueColumns,
  reorderIssueColumn,
  type IssueDropAction,
} from "@/lib/issues/board-model"
import { toast } from "sonner"
import { PlusIcon } from "lucide-react"
import { IssueBoard } from "./board/issue-board"
import { IssueBoardToolbar } from "./board/board-toolbar"
import { IssueList } from "./issue-list"
import { IssueDetailPanel } from "./issue-detail-panel"
import { CreateIssueDialog } from "./create-issue-dialog"

/** Stable empty reference, so the no-workspace path cannot churn memos. */
const EMPTY_ITEMS: UnifiedIssueItem[] = []

/** The local human has no id — see `IssueActor`. */
const VIEWER: IssueViewerContext = { selfKey: "human:self", agentKeys: [] }

export interface IssueConsoleProps {
  /** Deep-linked issue (`/issues?id=…`), since a static export has no `[id]`. */
  initialSelectedId?: string
}

export function IssueConsole({ initialSelectedId }: IssueConsoleProps) {
  const t = useTranslations("issues")
  const projectId = useProjectStore((s) => s.activeProjectId)

  const [viewId, setViewId] = useState(DEFAULT_ISSUE_VIEW_ID)
  const [filter, setFilter] = useState<IssueBoardFilter>(EMPTY_ISSUE_FILTER)
  const [layout, setLayout] = useState<IssueViewLayout | null>(null)
  const [groupBy, setGroupBy] = useState<IssueGroupBy | null>(null)
  const [sort, setSort] = useState<IssueSortMode | null>(null)
  const [selectedId, setSelectedId] = useState<string | undefined>(
    initialSelectedId ? `local:${initialSelectedId}` : undefined
  )

  const view = findIssueView(viewId) ?? BUILTIN_ISSUE_VIEWS[0]

  // Reactivity tick: any local write re-emits and re-runs the registry fan-out.
  const localRows = useClientLiveQuery(
    () => (projectId ? listIssues({ projectId }) : Promise.resolve([])),
    [projectId],
    []
  )
  const projects = useClientLiveQuery(
    () => (projectId ? listIssueProjects({ projectId }) : Promise.resolve([])),
    [projectId],
    []
  )
  const labels = useClientLiveQuery(() => listLabels("issue"), [], [] as LabelRow[])

  const [federated, setFederated] = useState<UnifiedIssueItem[]>([])
  const [sourceErrors, setSourceErrors] = useState(0)
  /**
   * Manual re-read trigger for the federated sources. A GitHub write-back
   * changes nothing local, so `localSignature` cannot notice it — without this
   * a user would comment, watch nothing happen, and comment again.
   */
  const [federatedTick, setFederatedTick] = useState(0)

  /**
   * Reactivity tick as a VALUE, not an array identity.
   *
   * Depending on `localRows` directly makes the fan-out effect re-run on any
   * render where the hook hands back a fresh array — and since the effect
   * calls `setFederated`, that is a render loop. Dexie's `useLiveQuery`
   * happens to cache its result between emissions, so production survives it,
   * but the effect must not depend on that to stay correct.
   */
  const localSignature = useMemo(
    () => (localRows ?? []).map((row) => `${row.id}:${row.updatedAt}`).join("|"),
    [localRows]
  )

  useEffect(() => {
    // No synchronous `setState` on the no-workspace path: clearing here would
    // be a cascading render, and the empty case is a pure function of
    // `projectId` anyway (see `visibleFederated` below).
    if (!projectId) return
    let cancelled = false
    getIssueSourceRegistry()
      .listAll({ projectId })
      .then((result) => {
        if (cancelled) return
        setFederated(result.items)
        setSourceErrors(result.errors.length)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, localSignature, federatedTick])

  const labelsById = useMemo(
    () => new Map((labels ?? []).map((label) => [label.id, label])),
    [labels]
  )
  const projectNamesById = useMemo(
    () => new Map((projects ?? []).map((project) => [project.id, project.name])),
    [projects]
  )

  /** Federated rows are only meaningful inside a workspace. */
  const visibleFederated = projectId ? federated : EMPTY_ITEMS
  const scoped = useMemo(
    () => applyViewScope(visibleFederated, view.scope, VIEWER),
    [visibleFederated, view.scope]
  )
  const filtered = useMemo(() => applyIssueFilter(scoped, filter), [scoped, filter])
  const effectiveSort = sort ?? view.sort
  const sorted = useMemo(() => applyIssueSort(filtered, effectiveSort), [filtered, effectiveSort])

  const runHint = useMemo(() => issueRunHint(sorted, new Set()), [sorted])
  const effectiveLayout = layout ?? view.layout
  const effectiveGroupBy = groupBy ?? view.groupBy
  const groups = useMemo(
    () => buildIssueGroups(sorted, effectiveGroupBy),
    [sorted, effectiveGroupBy]
  )

  const selected = sorted.find((item) => item.unifiedId === selectedId)

  const [createOpen, setCreateOpen] = useState(false)
  const [createStatus, setCreateStatus] = useState<IssueStatus>("backlog")

  /**
   * Pull the change we just made back down from GitHub, then re-run the
   * federated fan-out. Round-tripping rather than patching the row locally is
   * deliberate: GitHub is the source of truth for these rows, and a local
   * optimistic edit would be a second one.
   */
  async function handleWritebackCompleted() {
    if (projectId) {
      await runWorkspaceGithubSync({ projectId, full: true }).catch(() => undefined)
    }
    setFederatedTick((tick) => tick + 1)
  }

  /**
   * Apply a board drop. Denials come back from the pure reducer already
   * classified, so this only has to localize them — the legality decision was
   * made in `lib/issues/board-model.ts`, and `moveIssue` re-checks it at the
   * write boundary so an IM callback or a stale drag can't slip past.
   */
  async function handleDrop(action: IssueDropAction) {
    if (action.type === "denied") {
      const item = sorted.find((candidate) => candidate.unifiedId === action.unifiedId)
      toast.error(
        t(`board.denied.${action.reason}`, {
          source: item ? t(`source.${item.kind}`) : t("source.local"),
        })
      )
      return
    }

    const parsed = parseUnifiedIssueId(action.unifiedId)
    if (parsed?.kind !== "local") return

    if (action.type === "move") {
      const denial = await moveIssue({
        id: parsed.sourceId,
        to: action.to,
        by: { kind: "human" },
      })
      if (denial && denial !== "issue-not-found") {
        toast.error(t(`board.denied.${denial}`, { source: t("source.local") }))
      }
      return
    }

    const item = sorted.find((candidate) => candidate.unifiedId === action.unifiedId)
    if (!item) return
    const column = buildIssueColumns(sorted).find((candidate) => candidate.status === item.status)
    if (!column) return
    await reorderIssues(reorderIssueColumn(column.items, action.unifiedId, action.targetIndex))
  }

  return (
    <FeaturePageShell
      storageId="issues"
      header={
        <FeaturePageHeader
          variant="management"
          title={t("title")}
          summary={t("summary", { count: sorted.length })}
          controls={
            <div className="flex flex-wrap items-center gap-2">
              <nav className="flex items-center gap-1" aria-label={t("title")}>
                {BUILTIN_ISSUE_VIEWS.map((candidate) => (
                  <Button
                    key={candidate.id}
                    size="sm"
                    variant={candidate.id === viewId ? "secondary" : "ghost"}
                    onClick={() => {
                      setViewId(candidate.id)
                      setLayout(null)
                      setGroupBy(null)
                      setSort(null)
                    }}
                    data-testid={`issue-view-${candidate.id}`}
                  >
                    {t(`views.${candidate.labelKey}`)}
                  </Button>
                ))}
              </nav>
              <span className="flex-1" />
              <Button
                size="sm"
                onClick={() => {
                  setCreateStatus("backlog")
                  setCreateOpen(true)
                }}
                disabled={!projectId}
                data-testid="issue-create-trigger"
              >
                <PlusIcon className="size-4" />
                {t("create.trigger")}
              </Button>
              <Badge variant="outline" className="font-normal" data-testid="issue-agents-working">
                {t("board.agentsWorking", { count: runHint.running })}
              </Badge>
              {sourceErrors > 0 ? (
                <Badge variant="destructive" data-testid="issue-source-errors">
                  {t("source.degraded", { count: sourceErrors })}
                </Badge>
              ) : null}
              <IssueBoardToolbar
                items={scoped}
                filter={filter}
                onFilterChange={setFilter}
                layout={effectiveLayout}
                onLayoutChange={setLayout}
                groupBy={effectiveGroupBy}
                onGroupByChange={setGroupBy}
                sort={effectiveSort}
                onSortChange={setSort}
                labelsById={labelsById}
                projectNamesById={projectNamesById}
              />
            </div>
          }
        />
      }
      rightPane={
        selected
          ? {
              label: t("detail.properties"),
              content: (
                <IssueDetailPanel
                  item={selected}
                  labelsById={labelsById}
                  projectNamesById={projectNamesById}
                  onClose={() => setSelectedId(undefined)}
                  onWritebackCompleted={handleWritebackCompleted}
                />
              ),
            }
          : undefined
      }
      centerClassName="min-h-0"
    >
      {effectiveLayout === "board" ? (
        <IssueBoard
          items={sorted}
          labelsById={labelsById}
          projectNamesById={projectNamesById}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onDrop={handleDrop}
          onAddIssue={(status) => {
            setCreateStatus(status)
            setCreateOpen(true)
          }}
        />
      ) : (
        <IssueList
          groups={groups}
          groupBy={effectiveGroupBy}
          labelsById={labelsById}
          projectNamesById={projectNamesById}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      )}

      {projectId ? (
        <CreateIssueDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          projectId={projectId}
          projects={projects ?? []}
          status={createStatus}
          onCreated={(issueId) => setSelectedId(`local:${issueId}`)}
        />
      ) : null}
    </FeaturePageShell>
  )
}
