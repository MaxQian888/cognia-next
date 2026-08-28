"use client"

/**
 * The `/issues` surface — the total board.
 *
 * Reads through the `IssueSourceRegistry`, not straight from Dexie, so the
 * GitHub mirror and agent-task sources light up by registering an adapter with
 * no change here. Reactivity comes from a Dexie live query on the local table:
 * any local write re-emits, which re-runs the registry fan-out. Federated
 * sources refresh on their own cadence and are picked up by the same fan-out.
 *
 * LAYOUT — three bands, and each one exists because the previous single-slot
 * version broke:
 *
 *   - The RAIL (`leftPane`) owns views, delivery containers and labels. All of
 *     that used to sit in `FeaturePageHeader`'s `controls` slot, which renders
 *     inside `overflow-x-auto` with the scrollbar hidden — so on a narrow
 *     window the view tabs and the create button scrolled off the right edge
 *     with nothing on screen to say they were there.
 *   - The HEADER is back to one row: identity, counts, and the primary action.
 *   - The FILTER BAR sits above the board and, crucially, renders a chip per
 *     engaged filter. A count badge on a closed menu is not evidence.
 *
 * Display preferences live in `stores/issues/issue-view-store.ts`, per view.
 * They used to be `useState`, so leaving the route and coming back reset the
 * board every time.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { CircleDotIcon, PanelLeftIcon } from "lucide-react"
import { toast } from "sonner"

import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useClientLiveQuery } from "@/hooks/data"
import { useAssigneeOptions } from "@/hooks/issues/use-assignee-options"
import { useIssueSelection } from "@/hooks/issues/use-issue-selection"
import { useIssueShortcuts } from "@/hooks/issues/use-issue-shortcuts"
import { listIssues, moveIssue, reorderIssues } from "@/lib/db/issues"
import { listIssueProjects } from "@/lib/db/issue-projects"
import { listLabels } from "@/lib/db/labels"
import {
  actorKey,
  applyIssueFilter,
  buildIssueColumns,
  buildIssueGroups,
  issueRunHint,
  reorderIssueColumn,
  type IssueBoardFilter,
  type IssueDropAction,
} from "@/lib/issues/board-model"
import { applyIssueBulkAction, type IssueBulkAction } from "@/lib/issues/bulk-actions"
import { buildIssueLabelCatalogue } from "@/lib/issues/github-label-display"
import { computeProgressFromIssues } from "@/lib/issues/project-progress"
import {
  listRunningIssueIds,
  loadIssueViewerContext,
  SELF_ACTOR_KEY,
} from "@/lib/issues/run/running"
import { getIssueSourceRegistry } from "@/lib/issues/sources/registry"
import { runWorkspaceGithubSync } from "@/lib/issues/sync-runner"
import { setSoleFilterValue, toggleFilterValue } from "@/lib/issues/filter-chips"
import {
  applyIssueSort,
  applyViewScope,
  BUILTIN_ISSUE_VIEWS,
  countIssuesPerView,
  findIssueView,
  resolveIssueViewPreferences,
  type IssueViewerContext,
} from "@/lib/issues/views"
import { useIssueViewStore } from "@/stores/issues/issue-view-store"
import { useProjectStore } from "@/stores/project/project-store"
import type { IssueActor, IssueStatus } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { makeUnifiedIssueId, parseUnifiedIssueId } from "@/types/issues/unified"
import { DeleteIssueDialog } from "./delete-issue-dialog"
import { IssueContextMenu } from "./issue-context-menu"
import { IssueBoard } from "./board/issue-board"
import { IssueFilterBar } from "./filter-bar/issue-filter-bar"
import { IssueBulkToolbar } from "./list/issue-bulk-toolbar"
import { IssueList } from "./list/issue-list"
import { ManageLabelsDialog } from "./rail/manage-labels-dialog"
import { IssueRail } from "./rail/issue-rail"
import { IssueDetailPanel } from "./issue-detail-panel"
import { CreateIssueDialog } from "./create-issue-dialog"
import { CollabConflictsPanel } from "./collab-conflicts-panel"
import { CollabRefreshStaleBadge } from "./collab-refresh-stale-badge"

/** Stable empty reference, so the no-workspace path cannot churn memos. */
const EMPTY_ITEMS: UnifiedIssueItem[] = []

/**
 * The local human has no id — see `IssueActor`. `agentKeys` is filled in from
 * the Character table and the AgentTeam store at runtime
 * (`loadIssueViewerContext`); this is only the pre-load value.
 */
const INITIAL_VIEWER: IssueViewerContext = { selfKey: SELF_ACTOR_KEY, agentKeys: [] }

export interface IssueConsoleProps {
  /** Deep-linked issue (`/issues?id=…`), since a static export has no `[id]`. */
  initialSelectedId?: string
  /**
   * Deep-linked container filter (`/issues?project=…`), which is what the
   * projects console's "view these issues" produces.
   */
  initialProjectId?: string
}

export function IssueConsole({ initialSelectedId, initialProjectId }: IssueConsoleProps) {
  const t = useTranslations("issues")
  const projectId = useProjectStore((s) => s.activeProjectId)

  const viewId = useIssueViewStore((s) => s.viewId)
  const overrides = useIssueViewStore((s) => s.overrides[s.viewId])
  const railCollapsed = useIssueViewStore((s) => s.railCollapsed)
  const setViewId = useIssueViewStore((s) => s.setViewId)
  const setRailCollapsed = useIssueViewStore((s) => s.setRailCollapsed)
  const setFilter = useIssueViewStore((s) => s.setFilter)
  const setLayout = useIssueViewStore((s) => s.setLayout)
  const setGroupBy = useIssueViewStore((s) => s.setGroupBy)
  const setSort = useIssueViewStore((s) => s.setSort)
  const setDensity = useIssueViewStore((s) => s.setDensity)
  const toggleColumnCollapsed = useIssueViewStore((s) => s.toggleColumnCollapsed)
  const resetView = useIssueViewStore((s) => s.resetView)

  const view = findIssueView(viewId) ?? BUILTIN_ISSUE_VIEWS[0]
  const prefs = useMemo(() => resolveIssueViewPreferences(view, overrides), [view, overrides])

  /**
   * Apply `?project=` once, then never again.
   *
   * It writes to the persisted view store rather than to React state, so it
   * has to be a one-shot: re-applying on every render would make the container
   * filter impossible to take off. The ref is written inside the effect, not
   * during render.
   */
  const deepLinkApplied = useRef(false)
  useEffect(() => {
    if (deepLinkApplied.current || !initialProjectId) return
    deepLinkApplied.current = true
    const current = useIssueViewStore.getState()
    const active = resolveIssueViewPreferences(
      findIssueView(current.viewId) ?? BUILTIN_ISSUE_VIEWS[0],
      current.overrides[current.viewId]
    )
    current.setFilter(
      current.viewId,
      setSoleFilterValue(active.filter, "issueProjectIds", initialProjectId)
    )
  }, [initialProjectId])

  const [selectedId, setSelectedId] = useState<string | undefined>(
    initialSelectedId ? `local:${initialSelectedId}` : undefined
  )
  const searchRef = useRef<HTMLInputElement>(null)

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
  const labels = useClientLiveQuery(() => listLabels("issue"), [], [])

  const [federated, setFederated] = useState<UnifiedIssueItem[]>([])
  const [sourceErrors, setSourceErrors] = useState(0)
  /** Who counts as "my agents and squads" — every local Character and AgentTeam. */
  const [viewer, setViewer] = useState<IssueViewerContext>(INITIAL_VIEWER)
  /** Local issue ids with an active run — the "N agents working" pill. */
  const runningIds = useClientLiveQuery(
    () => (projectId ? listRunningIssueIds(projectId) : Promise.resolve(new Set<string>())),
    [projectId],
    new Set<string>()
  )
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
   * calls `setFederated`, that is a render loop.
   */
  const localSignature = useMemo(
    () => (localRows ?? []).map((row) => `${row.id}:${row.updatedAt}`).join("|"),
    [localRows]
  )

  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    getIssueSourceRegistry()
      .listAll({ projectId })
      .then((result) => {
        if (cancelled) return
        setFederated(result.items)
        setSourceErrors(result.errors.length)
      })
    void loadIssueViewerContext()
      .then((context) => {
        if (!cancelled) setViewer(context)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [projectId, localSignature, federatedTick])

  /** Federated rows are only meaningful inside a workspace. */
  const visibleFederated = projectId ? federated : EMPTY_ITEMS

  /**
   * Local labels PLUS ephemeral rows for GitHub's namespaced ids. Without the
   * second half, `github:bug` resolved to nothing, every chip was filtered out
   * and the filter menu showed the user the literal id.
   */
  const labelsById = useMemo(
    () => buildIssueLabelCatalogue(labels ?? [], visibleFederated),
    [labels, visibleFederated]
  )
  /**
   * The rail's label list is the MERGED catalogue: filtering by a GitHub label
   * is legitimate, so its projections belong here.
   */
  const railLabels = useMemo(
    () => [...labelsById.values()].sort((a, b) => a.name.localeCompare(b.name)),
    [labelsById]
  )
  /**
   * Every WRITE menu gets local labels only. A GitHub projection is not a row
   * in the `labels` table, so offering to apply one would write a synthetic
   * `github:<name>` id into a local issue's `labelIds` — an id that resolves
   * only while that GitHub issue happens to be on the board.
   */
  const writableLabels = useMemo(
    () => [...(labels ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [labels]
  )
  const projectNamesById = useMemo(
    () => new Map((projects ?? []).map((project) => [project.id, project.name])),
    [projects]
  )

  const scoped = useMemo(
    () => applyViewScope(visibleFederated, view.scope, viewer),
    [visibleFederated, view.scope, viewer]
  )
  const filtered = useMemo(() => applyIssueFilter(scoped, prefs.filter), [scoped, prefs.filter])
  const sorted = useMemo(() => applyIssueSort(filtered, prefs.sort), [filtered, prefs.sort])

  const runHint = useMemo(
    () =>
      issueRunHint(
        sorted,
        // `issueRunHint` keys on `unifiedId`; the run index holds local issue ids.
        new Set([...(runningIds ?? [])].map((id) => makeUnifiedIssueId("local", id)))
      ),
    [sorted, runningIds]
  )
  /** The board and the list both speak `unifiedId`; the run index does not. */
  const runningUnifiedIds = useMemo(
    () => new Set([...(runningIds ?? [])].map((id) => makeUnifiedIssueId("local", id))),
    [runningIds]
  )
  const groups = useMemo(() => buildIssueGroups(sorted, prefs.groupBy), [sorted, prefs.groupBy])

  /** Rail tallies come from the unfiltered scope — a filter must not hide its own count. */
  const viewCounts = useMemo(
    () => countIssuesPerView(visibleFederated, viewer),
    [visibleFederated, viewer]
  )
  /**
   * `actorKey` → cached display name, for the list's assignee group headings
   * and anywhere else a bare key would otherwise surface.
   */
  const assigneeLabels = useMemo(() => {
    const labels = new Map<string, string>()
    for (const item of scoped) {
      const key = actorKey(item.assignee)
      if (key && item.assignee && !labels.has(key)) {
        labels.set(key, item.assignee.label ?? t(`actor.${item.assignee.kind}`))
      }
    }
    return labels
  }, [scoped, t])
  const labelCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of scoped) {
      for (const labelId of item.labelIds) counts.set(labelId, (counts.get(labelId) ?? 0) + 1)
    }
    return counts
  }, [scoped])
  const projectProgress = useMemo(
    () =>
      computeProgressFromIssues(
        (projects ?? []).map((project) => project.id),
        localRows ?? []
      ),
    [projects, localRows]
  )

  const selected = sorted.find((item) => item.unifiedId === selectedId)
  /**
   * Repos bound to the selected issue's own container. Scoped rather than
   * workspace-wide because the GitHub loop runs against the container's repo,
   * so offering another container's would produce a ref the adapter refuses.
   */
  const selectedGithubRepos = useMemo(() => {
    if (!selected?.issueProjectId) return []
    const container = (projects ?? []).find((project) => project.id === selected.issueProjectId)
    return (container?.resources ?? [])
      .filter((resource) => resource.kind === "github-repo")
      .map((resource) => resource.repoFullName)
  }, [selected, projects])

  /**
   * The rows a bulk action would reach, in display order. Built from the same
   * `groups` the list renders so shift-range selects what the eye sees rather
   * than what an unrendered sort produced.
   */
  const orderedIds = useMemo(
    () => groups.flatMap((group) => group.items.map((item) => item.unifiedId)),
    [groups]
  )
  const selection = useIssueSelection(orderedIds)
  const assigneeOptions = useAssigneeOptions()
  const itemsById = useMemo(() => new Map(sorted.map((item) => [item.unifiedId, item])), [sorted])
  const checkedItems = useMemo(
    () =>
      [...selection.selectedIds]
        .map((id) => itemsById.get(id))
        .filter((item): item is UnifiedIssueItem => Boolean(item)),
    [selection.selectedIds, itemsById]
  )
  const [deleteTargets, setDeleteTargets] = useState<readonly UnifiedIssueItem[]>([])
  const [manageLabelsOpen, setManageLabelsOpen] = useState(false)

  const [createOpen, setCreateOpen] = useState(false)
  const [createStatus, setCreateStatus] = useState<IssueStatus>("backlog")

  const openCreate = useCallback((status: IssueStatus = "backlog") => {
    setCreateStatus(status)
    setCreateOpen(true)
  }, [])

  useIssueShortcuts({
    create: () => {
      if (projectId) openCreate()
    },
    focusSearch: () => searchRef.current?.focus(),
    next: () => selection.moveCursor(1),
    previous: () => selection.moveCursor(-1),
    open: () => {
      if (selection.cursorId) setSelectedId(selection.cursorId)
    },
    toggleSelect: () => {
      if (selection.cursorId) selection.toggle(selection.cursorId)
    },
    clearSelection: () => {
      if (selection.selectedIds.size > 0) selection.clear()
      else setSelectedId(undefined)
    },
  })

  const updateFilter = useCallback(
    (next: IssueBoardFilter) => setFilter(viewId, next),
    [setFilter, viewId]
  )

  /**
   * Run one action over a set of issues and say what actually happened.
   *
   * The outcome is reported rather than assumed: a selection mixing local and
   * GitHub rows cannot all be written, and "12 updated" when four were skipped
   * is a claim the user has no way to check.
   */
  const runBulk = useCallback(
    async (targets: readonly UnifiedIssueItem[], action: IssueBulkAction) => {
      const by: IssueActor = { kind: "human" }
      const outcome = await applyIssueBulkAction(targets, action, by, runningUnifiedIds)
      if (outcome.failed > 0) {
        toast.error(t("bulk.failed", { count: outcome.failed }))
      } else if (outcome.applied === 0) {
        // Nothing landed: explain with the guard's own reason when there is one.
        toast.error(
          outcome.reason
            ? t(`board.denied.${outcome.reason}`, { source: t("source.local") })
            : t("bulk.nothing")
        )
      } else if (outcome.skipped > 0) {
        toast.warning(t("bulk.skipped", { count: outcome.applied, skipped: outcome.skipped }))
      } else {
        toast.success(t("bulk.applied", { count: outcome.applied }))
      }
    },
    [runningUnifiedIds, t]
  )

  /**
   * The shared right-click menu, wrapped around every row and every card. One
   * menu, one action vocabulary (`IssueBulkAction`) and one capability gate,
   * whether it fires on a single issue or on a selection.
   */
  const renderItemMenu = useCallback(
    (item: UnifiedIssueItem, children: ReactNode) => (
      <IssueContextMenu
        key={item.unifiedId}
        item={item}
        running={runningUnifiedIds.has(item.unifiedId)}
        labels={writableLabels}
        projects={projects ?? []}
        assigneeOptions={assigneeOptions}
        onAction={(action) => void runBulk([item], action)}
        onOpen={() => setSelectedId(item.unifiedId)}
        onRequestDelete={() => setDeleteTargets([item])}
      >
        {children}
      </IssueContextMenu>
    ),
    [runningUnifiedIds, writableLabels, projects, assigneeOptions, runBulk]
  )

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
          icon={<CircleDotIcon />}
          title={t("title")}
          summary={t("summary", { count: sorted.length })}
          status={
            <div className="flex items-center gap-1.5">
              <CollabRefreshStaleBadge />
              {runHint.running > 0 ? (
                <Badge variant="outline" className="font-normal" data-testid="issue-agents-working">
                  {t("board.agentsWorking", { count: runHint.running })}
                </Badge>
              ) : null}
              {sourceErrors > 0 ? (
                <Badge variant="destructive" data-testid="issue-source-errors">
                  {t("source.degraded", { count: sourceErrors })}
                </Badge>
              ) : null}
            </div>
          }
          actions={
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={railCollapsed ? t("rail.show") : t("rail.hide")}
              title={railCollapsed ? t("rail.show") : t("rail.hide")}
              aria-pressed={!railCollapsed}
              onClick={() => setRailCollapsed(!railCollapsed)}
              data-testid="issue-rail-toggle"
            >
              <PanelLeftIcon className="size-4" />
            </Button>
          }
          primaryAction={{
            id: "create",
            label: t("create.trigger"),
            onSelect: () => openCreate(),
            disabled: !projectId,
            testId: "issue-create-trigger",
          }}
        />
      }
      leftPane={
        railCollapsed
          ? undefined
          : {
              label: t("rail.label"),
              content: (
                <IssueRail
                  viewId={viewId}
                  viewCounts={viewCounts}
                  onSelectView={setViewId}
                  projects={projects ?? []}
                  projectProgress={projectProgress}
                  activeProjectIds={prefs.filter.issueProjectIds}
                  onToggleProject={(id) =>
                    updateFilter(toggleFilterValue(prefs.filter, "issueProjectIds", id))
                  }
                  labels={railLabels}
                  labelCounts={labelCounts}
                  activeLabelIds={prefs.filter.labelIds}
                  onToggleLabel={(id) =>
                    updateFilter(toggleFilterValue(prefs.filter, "labelIds", id))
                  }
                  onManageLabels={() => setManageLabelsOpen(true)}
                />
              ),
            }
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
                  labels={writableLabels}
                  projects={projects ?? []}
                  assigneeOptions={assigneeOptions}
                  running={runningUnifiedIds.has(selected.unifiedId)}
                  githubRepos={selectedGithubRepos}
                  onAction={(action) => void runBulk([selected], action)}
                  onRequestDelete={() => setDeleteTargets([selected])}
                  onClose={() => setSelectedId(undefined)}
                  onWritebackCompleted={handleWritebackCompleted}
                />
              ),
            }
          : undefined
      }
      centerClassName="min-h-0"
    >
      <IssueFilterBar
        items={scoped}
        filter={prefs.filter}
        onFilterChange={updateFilter}
        layout={prefs.layout}
        onLayoutChange={(layout) => setLayout(viewId, layout)}
        groupBy={prefs.groupBy}
        onGroupByChange={(groupBy) => setGroupBy(viewId, groupBy)}
        sort={prefs.sort}
        onSortChange={(sort) => setSort(viewId, sort)}
        density={prefs.density}
        onDensityChange={(density) => setDensity(viewId, density)}
        onResetView={() => resetView(viewId)}
        labelsById={labelsById}
        projectNamesById={projectNamesById}
        searchRef={searchRef}
      />

      <IssueBulkToolbar
        items={checkedItems}
        runningIds={runningUnifiedIds}
        labels={writableLabels}
        projects={projects ?? []}
        assigneeOptions={assigneeOptions}
        onAction={(action) => void runBulk(checkedItems, action)}
        onRequestDelete={() => setDeleteTargets(checkedItems)}
        onToggleAll={selection.toggleAll}
        visibleCount={orderedIds.length}
        onClear={selection.clear}
      />

      {prefs.layout === "board" ? (
        <IssueBoard
          items={sorted}
          labelsById={labelsById}
          projectNamesById={projectNamesById}
          runningIds={runningUnifiedIds}
          columnCollapse={prefs.columnCollapse}
          onToggleColumnCollapsed={(status, count) => toggleColumnCollapsed(viewId, status, count)}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onDrop={handleDrop}
          onAddIssue={openCreate}
          renderItemMenu={renderItemMenu}
        />
      ) : (
        <IssueList
          groups={groups}
          groupBy={prefs.groupBy}
          density={prefs.density}
          labelsById={labelsById}
          projectNamesById={projectNamesById}
          runningIds={runningUnifiedIds}
          assigneeLabels={assigneeLabels}
          selectedId={selectedId}
          onSelect={(id) => {
            // Clicking a row also moves the keyboard cursor, so `j`/`k`
            // continue from where the eye already is rather than from the top.
            selection.setCursorId(id)
            setSelectedId(id)
          }}
          checkedIds={selection.selectedIds}
          onToggleCheck={(id, modifiers) =>
            modifiers.shiftKey ? selection.extendTo(id) : selection.toggle(id)
          }
          cursorId={selection.cursorId}
          renderItemMenu={renderItemMenu}
        />
      )}

      <ManageLabelsDialog
        open={manageLabelsOpen}
        onOpenChange={setManageLabelsOpen}
        labels={writableLabels}
      />

      <CollabConflictsPanel />

      <DeleteIssueDialog
        open={deleteTargets.length > 0}
        onOpenChange={(open) => {
          if (!open) setDeleteTargets([])
        }}
        items={deleteTargets}
        onConfirm={async () => {
          await runBulk(deleteTargets, { kind: "delete" })
          // A deleted row must not stay in the inspector or the selection.
          if (deleteTargets.some((item) => item.unifiedId === selectedId)) {
            setSelectedId(undefined)
          }
          selection.clear()
        }}
      />

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
