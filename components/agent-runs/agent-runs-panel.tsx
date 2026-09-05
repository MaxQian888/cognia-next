"use client"

/**
 * The task cockpit — one place to answer "what is running, what is stuck, what
 * failed" across every execution kind.
 *
 * It used to list four kinds (goal / team / plan / scheduled-task) fanned in
 * from four private stores. Chat turns, workflows, delegations and background
 * jobs — most of what actually runs — could not appear, because the view model
 * it mapped through had no member for them.
 *
 * Now it reads the run journal directly (`useExecutionCockpit`), so a kind
 * shows up here the moment it has a bridge, and controls come from the
 * projection's own `allowedActions` rather than from a per-kind switch.
 *
 * The `?run=` / `?kind=` deep-link contract is unchanged — `run-reducer.ts`
 * stamps `detailsUrl: /agent-runs?run=<id>` into every IM card, and
 * `tests/e2e/agent-runs/goal-control.spec.ts` guards it.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { ActivityIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { formatRelativeTime } from "@/lib/scheduler/format-utils"
import { useExecutionCockpit } from "@/hooks/agent-runs/use-agent-runs"
import { useRunControlActions } from "@/hooks/agent-runs/use-agent-run-actions"
import {
  COCKPIT_STATUS_GROUPS,
  filterKindLabelKey,
  runKindLabelKey,
  type CockpitStatusGroup,
} from "@/lib/execution/cockpit-model"
import {
  EXECUTION_FILTER_KINDS,
  type ExecutionFilterKind,
  type UnifiedExecutionRow,
} from "@/lib/execution/monitor-model"
import { ResponsiveDetailSheet } from "@/components/shared/responsive-detail-sheet"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"
import { ExecutionStatusPill } from "./agent-run-status-pill"
import { RunDetailPane } from "./run-detail-pane"

const LIVE_STATUSES = new Set(["running", "queued", "waiting"])

export interface AgentRunsPanelProps {
  /** `UnifiedExecutionRow.runId` or `nativeId` — whichever the deep link carried. */
  selectedId?: string
  onSelect: (runId: string | null) => void
  statusGroup?: CockpitStatusGroup | "all"
  onStatusGroup?: (group: CockpitStatusGroup | "all") => void
  filterKind?: ExecutionFilterKind | "all"
  onFilterKind?: (kind: ExecutionFilterKind | "all") => void
  /**
   * Only this Squad's runs (ADR-0169). The `/squads` Runs tab is this panel
   * with the Squad pinned, not a second history implementation.
   */
  teamId?: string
  /**
   * Hosted inside another page. Drops the page header (the host has one) and
   * keeps the filter controls and the list/detail split.
   */
  embedded?: boolean
}

export function AgentRunsPanel({
  selectedId,
  onSelect,
  statusGroup = "all",
  onStatusGroup,
  filterKind = "all",
  onFilterKind,
  teamId,
  embedded = false,
}: AgentRunsPanelProps) {
  const t = useTranslations("agentRuns")
  const { rows, allRows, selectedRow, statusCounts, kindCounts, isLoading, hasMore, loadMore } =
    useExecutionCockpit({
      ...(statusGroup !== "all" ? { statusGroup } : {}),
      ...(filterKind !== "all" ? { kind: filterKind } : {}),
      ...(teamId ? { teamId } : {}),
      ...(selectedId ? { selectedId } : {}),
    })
  const actions = useRunControlActions()
  const compact = useCompactLayout()

  /**
   * Deep links carry the RUN id; the row's own key is source-prefixed. Match on
   * either so a `?run=` from an IM card resolves whether the run is currently
   * projected from the journal or from a live broker leg.
   */
  const selected = useMemo(
    () =>
      selectedId
        ? (rows.find((row) => row.runId === selectedId || row.nativeId === selectedId) ??
          allRows.find((row) => row.runId === selectedId || row.nativeId === selectedId) ??
          selectedRow ??
          null)
        : null,
    [rows, allRows, selectedRow, selectedId]
  )

  const controls = (
    <div className="flex flex-wrap items-center gap-1.5">
      <div className="flex gap-1.5" role="tablist" aria-label={t("filters.statusLabel")}>
        <FilterChip
          label={t("filters.all")}
          count={allRows.length}
          selected={statusGroup === "all"}
          onSelect={() => onStatusGroup?.("all")}
        />
        {COCKPIT_STATUS_GROUPS.map((group) => (
          <FilterChip
            key={group}
            label={t(`filters.${group}`)}
            count={statusCounts[group]}
            selected={statusGroup === group}
            onSelect={() => onStatusGroup?.(group)}
          />
        ))}
      </div>
      <Select
        value={filterKind}
        onValueChange={(value) => onFilterKind?.(value as ExecutionFilterKind | "all")}
      >
        <SelectTrigger size="sm" aria-label={t("filters.kindLabel")} className="w-auto">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t("filters.allKinds")}</SelectItem>
          {EXECUTION_FILTER_KINDS.map((kind) => {
            const label = t(`kind.${filterKindLabelKey(kind)}`)
            return (
              <SelectItem key={kind} value={kind}>
                {kindCounts[kind]
                  ? t("filters.kindOption", { label, count: kindCounts[kind] })
                  : label}
              </SelectItem>
            )
          })}
        </SelectContent>
      </Select>
    </div>
  )

  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-testid="agent-runs-panel">
      {embedded ? (
        <div className="shrink-0 border-b px-3 py-2" data-testid="agent-runs-embedded-controls">
          {controls}
        </div>
      ) : (
        <FeaturePageHeader
          variant="compact"
          icon={<ActivityIcon />}
          title={t("title")}
          description={t("description")}
          controls={controls}
        />
      )}

      <div className="flex min-h-0 flex-1">
        {/*
          The list keeps the whole column on a narrow screen. It used to hold
          `max-w-sm shrink-0` there too, which at 375px meant it took every
          pixel and left the detail pane sitting off the right edge, scrolling
          the document sideways to reach 32px of nothing. The detail moves into
          the drawer below instead.
        */}
        <div
          className={cn("flex w-full min-w-0 flex-col", !compact && "max-w-sm shrink-0 border-r")}
        >
          <ul className="min-h-0 flex-1 overflow-y-auto" aria-label={t("title")}>
            {!isLoading && rows.length === 0 && (
              <li className="p-4 text-center text-xs text-muted-foreground">
                {allRows.length === 0 ? t("empty") : t("emptyFiltered")}
              </li>
            )}
            {rows.map((row) => (
              <li key={row.rowId}>
                <RunListRow
                  row={row}
                  selected={selected?.rowId === row.rowId}
                  onSelect={() => onSelect(row.runId ?? row.nativeId)}
                />
              </li>
            ))}
          </ul>
          {hasMore && (
            <div className="border-t p-2">
              <Button size="sm" variant="ghost" className="w-full" onClick={loadMore}>
                {t("loadMore")}
              </Button>
            </div>
          )}
        </div>

        {compact ? null : (
          <div className="min-w-0 flex-1 overflow-y-auto p-4">
            {selected ? (
              <RunDetailPane row={selected} actions={actions} />
            ) : (
              <p className="pt-8 text-center text-sm text-muted-foreground">
                {t("detail.selectPrompt")}
              </p>
            )}
          </div>
        )}
      </div>

      {compact ? (
        <ResponsiveDetailSheet
          open={Boolean(selected)}
          onOpenChange={(next) => {
            if (!next) onSelect(null)
          }}
          title={selected?.label ?? t("title")}
        >
          <div className="min-h-0 overflow-y-auto px-4 pb-4">
            {selected ? <RunDetailPane row={selected} actions={actions} /> : null}
          </div>
        </ResponsiveDetailSheet>
      ) : null}
    </div>
  )
}

function FilterChip({
  label,
  count,
  selected,
  onSelect,
}: {
  label: string
  count: number
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        "flex items-center gap-1 rounded-pill px-3 py-1 text-xs font-medium transition-colors",
        selected
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-muted-foreground hover:bg-muted/70"
      )}
    >
      {label}
      {count > 0 && <span className="tabular-nums opacity-70">{count}</span>}
    </button>
  )
}

function RunListRow({
  row,
  selected,
  onSelect,
}: {
  row: UnifiedExecutionRow
  selected: boolean
  onSelect: () => void
}) {
  const t = useTranslations("agentRuns")
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected}
      className={cn(
        "flex w-full flex-col gap-1 border-b px-3 py-2 text-left hover:bg-muted/50",
        selected && "bg-muted"
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{row.label}</span>
        <ExecutionStatusPill status={row.status} />
      </div>
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="uppercase">{t(`kind.${runKindLabelKey(row)}`)}</span>
        <span>·</span>
        <span>{formatRelativeTime(new Date(row.startedAt))}</span>
        {LIVE_STATUSES.has(row.status) && (
          <span className="ml-auto inline-flex items-center gap-1 text-blue-500">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
            {t("live")}
          </span>
        )}
      </div>
    </button>
  )
}
