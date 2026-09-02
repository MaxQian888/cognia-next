"use client"

/**
 * The issue kanban.
 *
 * A thin shell over `components/board/kanban-board.tsx` and
 * `lib/issues/board-model.ts`: columns, drop resolution, drop preview and
 * legality all come from the model, so the rules are unit-tested without
 * React. Illegal drop targets grey out at drag start (via the board's
 * `isDimmed`) rather than accepting the drop and failing after. Drag, the
 * collapse strip, the overlay portal and keyboard movement belong to the
 * shared primitive and are not re-implemented here.
 */

import { useCallback, useMemo, type ReactNode } from "react"
import { useTranslations } from "next-intl"

import {
  KanbanBoard,
  type KanbanColumnModel,
  type KanbanDragState,
} from "@/components/board/kanban-board"
import {
  buildIssueColumns,
  columnDropId,
  resolveIssueDrop,
  resolveIssueDropPreview,
  type IssueDropAction,
} from "@/lib/issues/board-model"
import { allowedIssueMoveTargets } from "@/lib/issues/state-machine"
import type { SquadRunRef } from "@/lib/issues/run/running"
import { resolveColumnCollapsed } from "@/lib/issues/views"
import type { IssueStatus } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import type { LabelRow } from "@/types/labels"
import { IssueStatusIcon, STATUS_COLUMN_TINT } from "../issue-glyphs"
import { buildIssueDndAnnouncements } from "./dnd-announcements"
import { IssueCard, IssueCardVisual } from "./issue-card"

type IssueColumn = KanbanColumnModel<IssueStatus, UnifiedIssueItem>
type IssueDrag = KanbanDragState<UnifiedIssueItem>

export interface IssueBoardProps {
  items: readonly UnifiedIssueItem[]
  /** Label catalogue, for resolving each card's `labelIds`. */
  labelsById?: ReadonlyMap<string, LabelRow>
  /** Delivery-container names, for the card's project chip. */
  projectNamesById?: ReadonlyMap<string, string>
  /** `unifiedId`s with an agent run currently in flight. */
  runningIds?: ReadonlySet<string>
  /** `unifiedId` to the Squad run that owns it, for the card's squad chip. */
  squadRuns?: ReadonlyMap<string, SquadRunRef>
  /** Per-column collapse overrides. Absent means "collapse iff empty". */
  columnCollapse?: Readonly<Partial<Record<IssueStatus, boolean>>>
  onToggleColumnCollapsed?: (status: IssueStatus, itemCount: number) => void
  selectedId?: string
  onSelect?: (unifiedId: string) => void
  onDrop?: (action: IssueDropAction) => void
  onAddIssue?: (status: IssueStatus) => void
  /** Wraps each card, so the console can attach the shared context menu. */
  renderItemMenu?: (item: UnifiedIssueItem, children: ReactNode) => ReactNode
}

const itemId = (item: UnifiedIssueItem) => item.unifiedId
const itemLabel = (item: UnifiedIssueItem) => item.identifier

export function IssueBoard({
  items,
  labelsById,
  projectNamesById,
  runningIds,
  squadRuns,
  columnCollapse,
  onToggleColumnCollapsed,
  selectedId,
  onSelect,
  onDrop,
  onAddIssue,
  renderItemMenu,
}: IssueBoardProps) {
  const t = useTranslations("issues")

  const columns = useMemo<IssueColumn[]>(
    () => buildIssueColumns(items).map((column) => ({ id: column.status, items: column.items })),
    [items]
  )
  const itemsById = useMemo(() => new Map(items.map((item) => [item.unifiedId, item])), [items])

  const isRunning = useCallback(
    (unifiedId: string) => runningIds?.has(unifiedId) ?? false,
    [runningIds]
  )

  const labelsOf = useCallback(
    (item: UnifiedIssueItem) =>
      item.labelIds
        .map((id) => labelsById?.get(id))
        .filter((label): label is LabelRow => Boolean(label)),
    [labelsById]
  )
  const projectNameOf = useCallback(
    (item: UnifiedIssueItem) =>
      item.issueProjectId ? projectNamesById?.get(item.issueProjectId) : undefined,
    [projectNamesById]
  )

  /** Which columns may legally receive the card currently being dragged. */
  const isDimmed = useCallback(
    (column: IssueColumn, drag: IssueDrag) => {
      const active = drag.activeItem
      if (!active || active.status === column.id) return false
      return !allowedIssueMoveTargets(active.capabilities, active.status, {
        runActive: isRunning(active.unifiedId),
      }).includes(column.id)
    },
    [isRunning]
  )

  /**
   * Cross-column only: within a column the sortable strategy's own gap already
   * shows the insertion point.
   */
  const insertionIndex = useCallback(
    (column: IssueColumn, drag: IssueDrag) => {
      const active = drag.activeItem
      if (!active || active.status === column.id) return null
      const preview = resolveIssueDropPreview(drag.activeId, drag.overId, itemsById, {
        runActive: isRunning(active.unifiedId),
      })
      return preview !== null && preview.status === column.id ? preview.index : null
    },
    [itemsById, isRunning]
  )

  const announcements = useMemo(
    () =>
      buildIssueDndAnnouncements({
        itemsById,
        columnSize: (status) => columns.find((column) => column.id === status)?.items.length ?? 0,
        statusLabel: (status) => t(`status.${status}`),
        preview: (active, over) =>
          resolveIssueDropPreview(active, over, itemsById, { runActive: isRunning(active) }),
        t: (key, values) => t(`board.dnd.${key}`, values),
      }),
    [itemsById, columns, isRunning, t]
  )

  const accessibility = useMemo(
    () => ({ announcements, screenReaderInstructions: { draggable: t("board.dnd.instructions") } }),
    [announcements, t]
  )

  const handleDrop = useCallback(
    (activeId: string, overId: string | null) => {
      const action = resolveIssueDrop(activeId, overId, itemsById, {
        runActive: isRunning(activeId),
      })
      if (action) onDrop?.(action)
    },
    [itemsById, isRunning, onDrop]
  )

  return (
    <KanbanBoard<IssueStatus, UnifiedIssueItem>
      columns={columns}
      itemId={itemId}
      itemLabel={itemLabel}
      columnLabel={(status) => t(`status.${status}`)}
      dropId={columnDropId}
      renderColumnIcon={(column) => <IssueStatusIcon status={column.id} />}
      columnClassName={(column) => STATUS_COLUMN_TINT[column.id]}
      renderCard={(item) => (
        <IssueCard
          item={item}
          labels={labelsOf(item)}
          projectName={projectNameOf(item)}
          selected={selectedId === item.unifiedId}
          running={isRunning(item.unifiedId)}
          squadRun={squadRuns?.get(item.unifiedId)}
          onSelect={onSelect}
        />
      )}
      renderOverlay={(item) => (
        <div className="w-66" data-testid="issue-drag-overlay">
          <IssueCardVisual
            item={item}
            labels={labelsOf(item)}
            projectName={projectNameOf(item)}
            running={isRunning(item.unifiedId)}
            squadRun={squadRuns?.get(item.unifiedId)}
            overlay
            draggable
          />
        </div>
      )}
      renderItemMenu={renderItemMenu}
      isCollapsed={(column) =>
        resolveColumnCollapsed(column.id, column.items.length, columnCollapse ?? {})
      }
      onToggleCollapsed={onToggleColumnCollapsed}
      onAddItem={onAddIssue}
      isDimmed={isDimmed}
      insertionIndex={insertionIndex}
      onDrop={handleDrop}
      emptyText={t("board.empty")}
      accessibility={accessibility}
      testId="issue-board"
      testIdPrefix="issue"
      className="h-full"
    />
  )
}
