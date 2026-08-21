"use client"

/**
 * The issue kanban.
 *
 * A thin dnd-kit shell over `lib/issues/board-model.ts`: columns, drop
 * resolution, drop preview and legality all come from there, so the rules are
 * unit-tested without React. Illegal drop targets grey out at drag start (via
 * `useDroppable.disabled`) rather than accepting the drop and failing after.
 *
 * LAYERING — read before touching the drag path.
 *
 * The dragged card rides a `<DragOverlay>` portaled to `document.body`, not a
 * `transform` on the card in place. Two independent things break the in-place
 * version, and both were live here before:
 *
 *   1. Clipping. The card sits inside a column with `overflow-y-auto`, inside
 *      a board with `overflow-x-auto`. A scroll container clips its
 *      descendants, so a transformed card physically cannot leave its own
 *      column — it vanishes at the column edge instead of following the cursor.
 *   2. Stacking. `opacity < 1` creates a stacking context at `z-auto`. The
 *      dragged card gets one (from its transform and its dimming) and so does
 *      every column greyed out as an illegal target — so columns later in DOM
 *      order paint OVER the card being dragged.
 *
 * `components/desktop/channel-list.tsx` solved exactly this: portal the clone
 * to the body and give it an explicit `zIndex` above the Radix layer. Follow
 * that, and do not re-introduce a bare transform "for simplicity".
 */

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  defaultDropAnimationSideEffects,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DropAnimation,
} from "@dnd-kit/core"
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable"
import { useMemo, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { useTranslations } from "next-intl"

import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { useBoardEdgeScroll } from "@/hooks/issues/use-board-edge-scroll"
import {
  buildIssueColumns,
  resolveIssueDrop,
  resolveIssueDropPreview,
  type IssueDropAction,
} from "@/lib/issues/board-model"
import { allowedIssueMoveTargets } from "@/lib/issues/state-machine"
import { resolveColumnCollapsed } from "@/lib/issues/views"
import type { IssueStatus } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import type { LabelRow } from "@/types/labels"
import { BoardColumn } from "./board-column"
import { buildIssueDndAnnouncements } from "./dnd-announcements"
import { IssueCardVisual } from "./issue-card"

/**
 * The clone glides onto the source card's rect on release, so the eye can
 * follow where the card ended up instead of having it teleport.
 */
const ISSUE_DROP_ANIMATION: DropAnimation = {
  duration: 200,
  easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
  sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: "0.4" } } }),
}

/**
 * dnd-kit's default keyboard activator claims both Space and Enter. Narrowing
 * it to Space leaves Enter free to OPEN a card — otherwise a keyboard user can
 * drag an issue but can never read one.
 */
const KEYBOARD_CODES = {
  start: ["Space"],
  cancel: ["Escape"],
  end: ["Space"],
}

/**
 * Never activate dnd-kit's own auto-scroll horizontally: on this board it
 * would grab the column's vertical scroller and fight `useBoardEdgeScroll`.
 * The y threshold is dnd-kit's own default.
 */
const AUTO_SCROLL = { threshold: { x: 0, y: 0.2 } }

export interface IssueBoardProps {
  items: readonly UnifiedIssueItem[]
  /** Label catalogue, for resolving each card's `labelIds`. */
  labelsById?: ReadonlyMap<string, LabelRow>
  /** Delivery-container names, for the card's project chip. */
  projectNamesById?: ReadonlyMap<string, string>
  /** `unifiedId`s with an agent run currently in flight. */
  runningIds?: ReadonlySet<string>
  /** Per-column collapse overrides; absent means "collapse iff empty". */
  columnCollapse?: Readonly<Partial<Record<IssueStatus, boolean>>>
  onToggleColumnCollapsed?: (status: IssueStatus, itemCount: number) => void
  selectedId?: string
  onSelect?: (unifiedId: string) => void
  onDrop?: (action: IssueDropAction) => void
  onAddIssue?: (status: IssueStatus) => void
  /** Wraps each card, so the console can attach the shared context menu. */
  renderItemMenu?: (item: UnifiedIssueItem, children: ReactNode) => ReactNode
}

export function IssueBoard({
  items,
  labelsById,
  projectNamesById,
  runningIds,
  columnCollapse,
  onToggleColumnCollapsed,
  selectedId,
  onSelect,
  onDrop,
  onAddIssue,
  renderItemMenu,
}: IssueBoardProps) {
  const t = useTranslations("issues")
  const { reduce } = useFlowMotion()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const edgeScroll = useBoardEdgeScroll(scrollerRef)

  // A pointer sensor with a small activation distance so a click on a card
  // selects it instead of starting a drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: KEYBOARD_CODES,
    })
  )

  const columns = useMemo(() => buildIssueColumns(items), [items])
  const itemsById = useMemo(() => new Map(items.map((item) => [item.unifiedId, item])), [items])

  const activeItem = activeId ? (itemsById.get(activeId) ?? null) : null
  const runActive = activeItem ? (runningIds?.has(activeItem.unifiedId) ?? false) : false

  // Which columns may legally receive the card currently being dragged.
  const legalTargets = useMemo(() => {
    if (!activeItem) return null
    return new Set<IssueStatus>([
      activeItem.status,
      ...allowedIssueMoveTargets(activeItem.capabilities, activeItem.status, { runActive }),
    ])
  }, [activeItem, runActive])

  const preview = useMemo(
    () => resolveIssueDropPreview(activeId, overId, itemsById, { runActive }),
    [activeId, overId, itemsById, runActive]
  )

  const announcements = useMemo(
    () =>
      buildIssueDndAnnouncements({
        itemsById,
        columnSize: (status) =>
          columns.find((column) => column.status === status)?.items.length ?? 0,
        statusLabel: (status) => t(`status.${status}`),
        preview: (active, over) =>
          resolveIssueDropPreview(active, over, itemsById, {
            runActive: runningIds?.has(active) ?? false,
          }),
        t: (key, values) => t(`board.dnd.${key}`, values),
      }),
    [itemsById, columns, runningIds, t]
  )

  function endDrag() {
    setActiveId(null)
    setOverId(null)
    edgeScroll.stop()
  }

  function handleDragEnd(event: DragEndEvent) {
    endDrag()
    const action = resolveIssueDrop(
      String(event.active.id),
      event.over ? String(event.over.id) : null,
      itemsById,
      { runActive }
    )
    if (action) onDrop?.(action)
  }

  /**
   * Feed the horizontal auto-scroll from the dragged card's own centre rather
   * than the pointer: dnd-kit's move event carries the translated rect but not
   * pointer coordinates, and the card's centre is the thing the user is
   * actually aiming at a column with.
   */
  function handleDragMove(event: DragMoveEvent) {
    const rect = event.active.rect.current.translated
    edgeScroll.track(rect ? rect.left + rect.width / 2 : null)
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      autoScroll={AUTO_SCROLL}
      accessibility={{
        announcements,
        screenReaderInstructions: { draggable: t("board.dnd.instructions") },
      }}
      onDragStart={(event: DragStartEvent) => setActiveId(String(event.active.id))}
      onDragMove={handleDragMove}
      onDragOver={(event: DragOverEvent) => setOverId(event.over ? String(event.over.id) : null)}
      onDragCancel={endDrag}
      onDragEnd={handleDragEnd}
    >
      <div
        ref={scrollerRef}
        className="flex h-full min-h-0 gap-3 overflow-x-auto p-3"
        data-testid="issue-board"
        role="list"
      >
        {columns.map((column) => {
          const dimmed = legalTargets !== null && !legalTargets.has(column.status)
          // Cross-column only: within a column the sortable strategy's own gap
          // already shows the insertion point.
          const showIndicator =
            preview !== null &&
            preview.status === column.status &&
            activeItem !== null &&
            activeItem.status !== column.status

          return (
            <BoardColumn
              key={column.status}
              status={column.status}
              items={column.items}
              labelsById={labelsById}
              projectNamesById={projectNamesById}
              runningIds={runningIds}
              selectedId={selectedId}
              onSelect={onSelect}
              onAddIssue={onAddIssue}
              renderItemMenu={renderItemMenu}
              collapsed={resolveColumnCollapsed(
                column.status,
                column.items.length,
                columnCollapse ?? {}
              )}
              onToggleCollapsed={
                onToggleColumnCollapsed
                  ? (status) => onToggleColumnCollapsed(status, column.items.length)
                  : undefined
              }
              dimmed={dimmed}
              insertionIndex={showIndicator ? preview.index : null}
              emptyText={t("board.empty")}
              statusLabel={t(`status.${column.status}`)}
              addLabel={t("board.addIssue", { status: t(`status.${column.status}`) })}
              collapseLabel={t("board.collapseColumn", { status: t(`status.${column.status}`) })}
              expandLabel={t("board.expandColumn", { status: t(`status.${column.status}`) })}
            />
          )
        })}
      </div>

      <IssueDragOverlay
        item={activeItem}
        reduce={reduce}
        labels={
          activeItem
            ? activeItem.labelIds
                .map((id) => labelsById?.get(id))
                .filter((label): label is LabelRow => Boolean(label))
            : undefined
        }
        projectName={
          activeItem?.issueProjectId ? projectNamesById?.get(activeItem.issueProjectId) : undefined
        }
        running={activeItem ? runningIds?.has(activeItem.unifiedId) : false}
      />
    </DndContext>
  )
}

/**
 * Pointer-following clone of the dragged card, portaled to the body so neither
 * the column's vertical scroller nor the board's horizontal one can clip it,
 * and stacked above the Radix portal layer (which sits at z-50) so no popover
 * or tooltip can paint over the thing the user is holding.
 */
function IssueDragOverlay({
  item,
  labels,
  projectName,
  running,
  reduce,
}: {
  item: UnifiedIssueItem | null
  labels?: readonly LabelRow[]
  projectName?: string
  running?: boolean
  reduce: boolean
}) {
  // Guard the SSR/static-export pass rather than assuming a client-only mount.
  if (typeof document === "undefined") return null
  return createPortal(
    <DragOverlay dropAnimation={reduce ? null : ISSUE_DROP_ANIMATION} zIndex={60}>
      {item ? (
        <div className="w-66" data-testid="issue-drag-overlay">
          <IssueCardVisual
            item={item}
            labels={labels}
            projectName={projectName}
            running={running}
            overlay
            draggable
          />
        </div>
      ) : null}
    </DragOverlay>,
    document.body
  )
}
