"use client"

/**
 * The one kanban board.
 *
 * `/issues` (`components/issues/board/issue-board.tsx`) and the Squad task
 * board (`components/agent/workspace/board/task-board.tsx`) used to each carry
 * their own DndContext, column chrome, collapse strip, empty state and drag
 * overlay. This is the single copy: columns, drag and drop, keyboard movement,
 * collapse, per-column and board-level empty states, the card slot and the
 * per-item menu wrapper. Everything domain-shaped (which drops are legal, what
 * a drop means, what a card looks like) stays with the consumer and arrives as
 * props, so the rules of each board remain testable without React.
 *
 * LAYERING, read before touching the drag path.
 *
 * The dragged card rides a `<DragOverlay>` portaled to `document.body`, not a
 * `transform` on the card in place. Two independent things break the in-place
 * version, and both were live before:
 *
 *   1. Clipping. A card sits inside a column with `overflow-y-auto`, inside a
 *      board with `overflow-x-auto`. A scroll container clips its descendants,
 *      so a transformed card cannot leave its own column.
 *   2. Stacking. `opacity < 1` creates a stacking context at `z-auto`. The
 *      dragged card gets one and so does every column greyed out as an illegal
 *      target, so columns later in DOM order paint OVER the card being dragged.
 *
 * `components/desktop/channel-list.tsx` solved exactly this: portal the clone
 * to the body and give it an explicit `zIndex` above the Radix layer.
 */

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  defaultDropAnimationSideEffects,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DropAnimation,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core"
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { Fragment, useCallback, useMemo, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"

import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { Button } from "@/components/ui/button"
import { useBoardEdgeScroll } from "@/hooks/issues/use-board-edge-scroll"
import { nextBoardColumnCoordinates, type BoardRect } from "@/lib/issues/board-keyboard"
import { cn } from "@/lib/utils"

/** One column's worth of items, in the order the consumer wants them shown. */
export interface KanbanColumnModel<TId extends string, TItem> {
  id: TId
  items: readonly TItem[]
}

/** What the board knows about the drag in flight, handed to every rule prop. */
export interface KanbanDragState<TItem> {
  activeId: string | null
  activeItem: TItem | null
  overId: string | null
}

const IDLE_DRAG: KanbanDragState<never> = { activeId: null, activeItem: null, overId: null }

export interface KanbanBoardProps<TId extends string, TItem> {
  columns: readonly KanbanColumnModel<TId, TItem>[]
  /** dnd-kit id of an item. Must be unique across the whole board. */
  itemId: (item: TItem) => string
  /** Spoken name of an item, for the default announcements. */
  itemLabel: (item: TItem) => string
  /** Localized column name: the header, the strip and the announcements. */
  columnLabel: (id: TId) => string
  /** dnd-kit id of a column's droppable. */
  dropId: (id: TId) => string
  /** The card slot. The card owns its own `useSortable` under `itemId`. */
  renderCard: (item: TItem, column: KanbanColumnModel<TId, TItem>) => ReactNode
  /** Leading glyph shown in the header and on the collapsed strip. */
  renderColumnIcon?: (column: KanbanColumnModel<TId, TItem>) => ReactNode
  /** Replaces the plain label in the header. The count and controls stay. */
  renderColumnHeader?: (column: KanbanColumnModel<TId, TItem>) => ReactNode
  /** Extra classes on the column shell: tint, width. */
  columnClassName?: (column: KanbanColumnModel<TId, TItem>) => string | undefined
  /** The clone that follows the pointer. Nothing is dragged visibly without it. */
  renderOverlay?: (item: TItem) => ReactNode
  /** Wraps each card, so a console can attach its shared context menu. */
  renderItemMenu?: (item: TItem, children: ReactNode) => ReactNode
  /** Whether a column renders as a vertical strip. Absent means never. */
  isCollapsed?: (column: KanbanColumnModel<TId, TItem>) => boolean
  /** Called with the column's current item count so a flip is relative to what is shown. */
  onToggleCollapsed?: (id: TId, itemCount: number) => void
  onAddItem?: (id: TId) => void
  /** This column would refuse the card being dragged. */
  isDimmed?: (column: KanbanColumnModel<TId, TItem>, drag: KanbanDragState<TItem>) => boolean
  /**
   * Where a CROSS-column drop would insert, or null. Same-column reorders are
   * left to `verticalListSortingStrategy`, whose gap already shows it.
   */
  insertionIndex?: (
    column: KanbanColumnModel<TId, TItem>,
    drag: KanbanDragState<TItem>
  ) => number | null
  /** Fires on release, with the raw dnd-kit ids. The consumer resolves what it means. */
  onDrop?: (activeId: string, overId: string | null) => void
  /** Read-only rendering: no sensors, every droppable disabled. */
  dragDisabled?: boolean
  /** Board-level empty state, shown INSTEAD of the columns when every one is empty. */
  emptyState?: ReactNode
  /** Per-column empty text. Defaults to the shared `board.emptyColumn`. */
  emptyText?: string
  /** Consumer-owned announcements. Defaults to the shared `board.dnd.*` set. */
  accessibility?: {
    announcements?: Announcements
    screenReaderInstructions?: { draggable: string }
  }
  /** `data-testid` of the scroller. */
  testId: string
  /** Prefix for every column-level `data-testid` (`${prefix}-column-${id}`). */
  testIdPrefix: string
  className?: string
}

/**
 * The clone glides onto the source card's rect on release, so the eye can
 * follow where the card ended up instead of having it teleport.
 */
const DROP_ANIMATION: DropAnimation = {
  duration: 200,
  easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
  sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: "0.4" } } }),
}

/**
 * dnd-kit's default keyboard activator claims both Space and Enter. Narrowing
 * it to Space leaves Enter free to OPEN a card. Otherwise a keyboard user can
 * drag a card but can never read one.
 */
const KEYBOARD_CODES = {
  start: ["Space"],
  cancel: ["Escape"],
  end: ["Space"],
}

/**
 * Never activate dnd-kit's own auto-scroll horizontally: it would grab the
 * column's vertical scroller and fight `useBoardEdgeScroll`. The y threshold
 * is dnd-kit's own default.
 */
const AUTO_SCROLL = { threshold: { x: 0, y: 0.2 } }

/** A click on a card selects it instead of starting a drag. */
const POINTER_ACTIVATION = { activationConstraint: { distance: 4 } }

const NO_SENSORS: never[] = []

export function KanbanBoard<TId extends string, TItem>({
  columns,
  itemId,
  itemLabel,
  columnLabel,
  dropId,
  renderCard,
  renderColumnIcon,
  renderColumnHeader,
  columnClassName,
  renderOverlay,
  renderItemMenu,
  isCollapsed,
  onToggleCollapsed,
  onAddItem,
  isDimmed,
  insertionIndex,
  onDrop,
  dragDisabled = false,
  emptyState,
  emptyText,
  accessibility,
  testId,
  testIdPrefix,
  className,
}: KanbanBoardProps<TId, TItem>) {
  const t = useTranslations("board")
  const { reduce } = useFlowMotion()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const edgeScroll = useBoardEdgeScroll(scrollerRef)

  const itemsById = useMemo(() => {
    const map = new Map<string, TItem>()
    for (const column of columns) for (const item of column.items) map.set(itemId(item), item)
    return map
  }, [columns, itemId])

  const columnIdOfItem = useCallback(
    (id: string): TId | null => {
      for (const column of columns) {
        if (column.items.some((item) => itemId(item) === id)) return column.id
      }
      return null
    },
    [columns, itemId]
  )

  /** A drop target is either a column's droppable or a card inside one. */
  const columnOfTarget = useCallback(
    (targetId: string): TId | null => {
      const asColumn = columns.find((column) => dropId(column.id) === targetId)
      return asColumn ? asColumn.id : columnIdOfItem(targetId)
    },
    [columns, dropId, columnIdOfItem]
  )

  /**
   * Left/Right walk the COLUMNS. Up/Down stay dnd-kit's sortable getter.
   *
   * dnd-kit's own getter assumes one sortable list. On several lists side by
   * side, each wrapped in a full-height column droppable, it ranks every
   * droppable by corner distance and picks whichever is nearest, which in
   * practice meant picking a card up in one column and being told the target
   * was the last one, with the arrow keys unable to change it.
   *
   */
  const dropIds = useMemo(() => columns.map((column) => dropId(column.id)), [columns, dropId])
  const coordinateGetter = useCallback<KeyboardCoordinateGetter>(
    (event, args) => {
      const direction =
        event.code === "ArrowRight" ? "right" : event.code === "ArrowLeft" ? "left" : null
      if (!direction) return sortableKeyboardCoordinates(event, args)

      // dnd-kit's own getter does this for the arrows it handles, and ours has
      // to as well, or the board scrolls sideways under the card being moved.
      event.preventDefault()

      const { collisionRect, droppableRects } = args.context
      if (!collisionRect) return undefined

      const columnRects = new Map<string, BoardRect>()
      for (const id of dropIds) {
        const rect = droppableRects.get(id)
        if (rect) columnRects.set(id, rect)
      }
      // Absolute client coordinates, matching what `sortableKeyboardCoordinates`
      // returns. Null means the board's edge: leaving the card put is what
      // stopping at the end should feel like.
      return nextBoardColumnCoordinates(direction, collisionRect, columnRects, dropIds) ?? undefined
    },
    [dropIds]
  )

  const sensors = useSensors(
    useSensor(PointerSensor, POINTER_ACTIVATION),
    useSensor(KeyboardSensor, { coordinateGetter, keyboardCodes: KEYBOARD_CODES })
  )

  const activeItem = activeId ? (itemsById.get(activeId) ?? null) : null
  const drag: KanbanDragState<TItem> = activeId ? { activeId, activeItem, overId } : IDLE_DRAG

  const defaultAnnouncements = useMemo<Announcements>(() => {
    const describe = (id: string, target: string | null, key: "over" | "dropped") => {
      const item = itemsById.get(id)
      if (!item) return undefined
      const from = columnIdOfItem(id)
      if (target === null) {
        return from === null
          ? undefined
          : t("dnd.cancelled", { item: itemLabel(item), column: columnLabel(from) })
      }
      const to = columnOfTarget(target)
      if (to === null) return t("dnd.denied", { item: itemLabel(item) })
      return t(`dnd.${key}`, { item: itemLabel(item), column: columnLabel(to) })
    }
    return {
      onDragStart: ({ active }) => {
        const item = itemsById.get(String(active.id))
        const from = columnIdOfItem(String(active.id))
        if (!item || from === null) return undefined
        return t("dnd.pickedUp", { item: itemLabel(item), column: columnLabel(from) })
      },
      onDragOver: ({ active, over }) =>
        describe(String(active.id), over ? String(over.id) : null, "over"),
      onDragEnd: ({ active, over }) =>
        describe(String(active.id), over ? String(over.id) : null, "dropped"),
      onDragCancel: ({ active }) => describe(String(active.id), null, "dropped"),
    }
  }, [itemsById, columnIdOfItem, columnOfTarget, itemLabel, columnLabel, t])

  function endDrag() {
    setActiveId(null)
    setOverId(null)
    edgeScroll.stop()
  }

  function handleDragEnd(event: DragEndEvent) {
    endDrag()
    onDrop?.(String(event.active.id), event.over ? String(event.over.id) : null)
  }

  /**
   * Feed the horizontal auto-scroll from the dragged card's own centre rather
   * than the pointer: dnd-kit's move event carries the translated rect but not
   * pointer coordinates, and the card's centre is what the user is aiming at a
   * column with.
   */
  function handleDragMove(event: DragMoveEvent) {
    const rect = event.active.rect.current.translated
    edgeScroll.track(rect ? rect.left + rect.width / 2 : null)
  }

  const totalItems = columns.reduce((sum, column) => sum + column.items.length, 0)

  return (
    <DndContext
      sensors={dragDisabled ? NO_SENSORS : sensors}
      collisionDetection={closestCorners}
      autoScroll={AUTO_SCROLL}
      accessibility={{
        announcements: accessibility?.announcements ?? defaultAnnouncements,
        screenReaderInstructions: accessibility?.screenReaderInstructions ?? {
          draggable: t("dnd.instructions"),
        },
      }}
      onDragStart={(event: DragStartEvent) => setActiveId(String(event.active.id))}
      onDragMove={handleDragMove}
      onDragOver={(event: DragOverEvent) => setOverId(event.over ? String(event.over.id) : null)}
      onDragCancel={endDrag}
      onDragEnd={handleDragEnd}
    >
      {emptyState !== undefined && totalItems === 0 ? (
        emptyState
      ) : (
        <div
          ref={scrollerRef}
          className={cn("flex min-h-0 gap-3 overflow-x-auto p-3", className)}
          data-testid={testId}
          role="list"
        >
          {columns.map((column) => {
            const label = columnLabel(column.id)
            const ids = column.items.map(itemId)
            return (
              <KanbanColumn
                key={column.id}
                id={column.id}
                dropId={dropId(column.id)}
                label={label}
                count={column.items.length}
                icon={renderColumnIcon?.(column)}
                header={renderColumnHeader?.(column)}
                className={columnClassName?.(column)}
                collapsed={isCollapsed?.(column) ?? false}
                onToggleCollapsed={
                  onToggleCollapsed
                    ? () => onToggleCollapsed(column.id, column.items.length)
                    : undefined
                }
                onAdd={onAddItem ? () => onAddItem(column.id) : undefined}
                dimmed={isDimmed?.(column, drag) ?? false}
                dragDisabled={dragDisabled}
                insertionIndex={insertionIndex?.(column, drag) ?? null}
                emptyText={emptyText ?? t("emptyColumn")}
                addLabel={t("addToColumn", { column: label })}
                collapseLabel={t("collapseColumn", { column: label })}
                expandLabel={t("expandColumn", { column: label })}
                testIdPrefix={testIdPrefix}
                sortableIds={ids}
                cards={column.items.map((item) => {
                  const card = renderCard(item, column)
                  return renderItemMenu ? renderItemMenu(item, card) : card
                })}
              />
            )
          })}
        </div>
      )}

      <KanbanDragOverlay reduce={reduce}>
        {activeItem !== null && renderOverlay ? renderOverlay(activeItem) : null}
      </KanbanDragOverlay>
    </DndContext>
  )
}

interface KanbanColumnProps {
  id: string
  dropId: string
  label: string
  count: number
  icon?: ReactNode
  header?: ReactNode
  className?: string
  collapsed: boolean
  onToggleCollapsed?: () => void
  onAdd?: () => void
  dimmed: boolean
  dragDisabled: boolean
  insertionIndex: number | null
  emptyText: string
  addLabel: string
  collapseLabel: string
  expandLabel: string
  testIdPrefix: string
  /** dnd-kit ids, parallel to `cards`. The column keys the cards by these. */
  sortableIds: readonly string[]
  cards: readonly ReactNode[]
}

/**
 * One column: a full column of cards or a collapsed vertical strip.
 *
 * The strip is NOT a hidden column: it keeps its `useDroppable`, so a card can
 * still be dropped on it and every transition stays reachable at any width.
 * That is the whole reason collapsing was chosen over hiding.
 */
function KanbanColumn({
  id,
  dropId,
  label,
  count,
  icon,
  header,
  className,
  collapsed,
  onToggleCollapsed,
  onAdd,
  dimmed,
  dragDisabled,
  insertionIndex,
  emptyText,
  addLabel,
  collapseLabel,
  expandLabel,
  testIdPrefix,
  sortableIds,
  cards,
}: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: dropId, disabled: dragDisabled || dimmed })

  const shellClass = cn(
    "flex shrink-0 flex-col rounded-xl border",
    "motion-safe:transition-[opacity,width] motion-safe:duration-200",
    dimmed && "pointer-events-none opacity-40",
    isOver && !dimmed && "ring-ring/50 ring-2",
    className
  )

  const indicator = (
    <div
      aria-hidden
      data-testid={`${testIdPrefix}-drop-indicator-${id}`}
      className="h-0.5 shrink-0 rounded-full bg-primary"
    />
  )

  if (collapsed) {
    return (
      <section
        ref={setNodeRef}
        role="listitem"
        aria-label={label}
        data-testid={`${testIdPrefix}-column-${id}`}
        data-collapsed="true"
        data-dimmed={dimmed || undefined}
        className={cn(shellClass, "w-11 items-center py-2")}
      >
        {/*
          A strip is still a landing spot, and because the usual collapse rule
          is "collapse iff empty", dropping onto one is the MOST common
          cross-column move. The bar spans the strip rather than sitting
          between cards: expanding the column mid-drag would shift the layout
          out from under the pointer.
        */}
        {insertionIndex !== null ? (
          <div
            aria-hidden
            data-testid={`${testIdPrefix}-drop-indicator-${id}`}
            className="mb-1.5 h-0.5 w-6 shrink-0 rounded-full bg-primary"
          />
        ) : null}
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label={expandLabel}
          title={expandLabel}
          data-testid={`${testIdPrefix}-column-expand-${id}`}
          className="focus-visible:ring-ring/50 flex min-h-0 flex-1 flex-col items-center gap-2 rounded-lg px-1 focus-visible:outline-none focus-visible:ring-[3px]"
        >
          {icon}
          <span
            className="text-xs tabular-nums text-muted-foreground"
            data-testid={`${testIdPrefix}-column-${id}-count`}
          >
            {count}
          </span>
          <span className="min-h-0 flex-1 overflow-hidden text-xs font-semibold [writing-mode:vertical-rl]">
            {label}
          </span>
          <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </section>
    )
  }

  return (
    <section
      ref={setNodeRef}
      role="listitem"
      aria-label={label}
      data-testid={`${testIdPrefix}-column-${id}`}
      data-dimmed={dimmed || undefined}
      className={cn(shellClass, "w-66")}
    >
      <header className="flex items-center gap-2 px-3 py-2.5">
        {icon}
        {header ?? <h2 className="min-w-0 truncate text-sm font-semibold">{label}</h2>}
        <span
          className="shrink-0 text-xs tabular-nums text-muted-foreground"
          data-testid={`${testIdPrefix}-column-${id}-count`}
        >
          {count}
        </span>
        <span className="flex-1" />
        {onAdd ? (
          <Button
            size="icon"
            variant="ghost"
            className="size-6 shrink-0"
            aria-label={addLabel}
            onClick={onAdd}
            data-testid={`${testIdPrefix}-column-add-${id}`}
          >
            <PlusIcon className="size-4" />
          </Button>
        ) : null}
        {onToggleCollapsed ? (
          <Button
            size="icon"
            variant="ghost"
            className="size-6 shrink-0"
            aria-label={collapseLabel}
            title={collapseLabel}
            onClick={onToggleCollapsed}
            data-testid={`${testIdPrefix}-column-collapse-${id}`}
          >
            <ChevronLeftIcon className="size-4" />
          </Button>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        <SortableContext items={sortableIds as string[]} strategy={verticalListSortingStrategy}>
          {cards.length === 0 && insertionIndex === null ? (
            <p className="py-8 text-center text-xs text-muted-foreground">{emptyText}</p>
          ) : (
            cards.map((card, index) => (
              <Fragment key={sortableIds[index]}>
                {insertionIndex === index ? indicator : null}
                {card}
              </Fragment>
            ))
          )}
          {insertionIndex !== null && insertionIndex >= cards.length ? indicator : null}
        </SortableContext>
      </div>
    </section>
  )
}

interface KanbanDragOverlayProps {
  reduce: boolean
  children: ReactNode
}

/**
 * Pointer-following clone, portaled to the body so neither the column's
 * vertical scroller nor the board's horizontal one can clip it, and stacked
 * above the Radix portal layer (z-50) so no popover can paint over the thing
 * the user is holding.
 */
function KanbanDragOverlay({ reduce, children }: KanbanDragOverlayProps) {
  // Guard the SSR/static-export pass rather than assuming a client-only mount.
  if (typeof document === "undefined") return null
  return createPortal(
    <DragOverlay dropAnimation={reduce ? null : DROP_ANIMATION} zIndex={60}>
      {children}
    </DragOverlay>,
    document.body
  )
}
