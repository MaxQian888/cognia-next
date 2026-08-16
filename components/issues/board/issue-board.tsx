"use client"

/**
 * The issue kanban.
 *
 * A thin dnd-kit shell over `lib/issues/board-model.ts`: columns, drop
 * resolution and legality all come from there, so the rules are unit-tested
 * without React. Illegal drop targets grey out at drag start (via
 * `useDroppable.disabled`) rather than accepting the drop and failing after —
 * the same affordance the Agent Team board uses.
 */

import {
  DndContext,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { PlusIcon } from "lucide-react"
import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  buildIssueColumns,
  columnDropId,
  resolveIssueDrop,
  type IssueDropAction,
} from "@/lib/issues/board-model"
import { allowedIssueMoveTargets } from "@/lib/issues/state-machine"
import { cn } from "@/lib/utils"
import type { IssueStatus } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import type { LabelRow } from "@/types/labels"
import { IssueStatusIcon, STATUS_COLUMN_TINT } from "../issue-glyphs"
import { IssueCard } from "./issue-card"

export interface IssueBoardProps {
  items: readonly UnifiedIssueItem[]
  /** Label catalogue, for resolving each card's `labelIds`. */
  labelsById?: ReadonlyMap<string, LabelRow>
  /** Delivery-container names, for the card's project chip. */
  projectNamesById?: ReadonlyMap<string, string>
  /** `unifiedId`s with an agent run currently in flight. */
  runningIds?: ReadonlySet<string>
  selectedId?: string
  onSelect?: (unifiedId: string) => void
  onDrop?: (action: IssueDropAction) => void
  onAddIssue?: (status: IssueStatus) => void
}

export function IssueBoard({
  items,
  labelsById,
  projectNamesById,
  runningIds,
  selectedId,
  onSelect,
  onDrop,
  onAddIssue,
}: IssueBoardProps) {
  const t = useTranslations("issues")
  const [activeId, setActiveId] = useState<string | null>(null)

  // A pointer sensor with a small activation distance so a click on a card
  // selects it instead of starting a drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const columns = useMemo(() => buildIssueColumns(items), [items])
  const itemsById = useMemo(() => new Map(items.map((item) => [item.unifiedId, item])), [items])

  // Which columns may legally receive the card currently being dragged.
  const legalTargets = useMemo(() => {
    if (!activeId) return null
    const active = itemsById.get(activeId)
    if (!active) return null
    const runActive = runningIds?.has(active.unifiedId) ?? false
    return new Set<IssueStatus>([
      active.status,
      ...allowedIssueMoveTargets(active.capabilities, active.status, { runActive }),
    ])
  }, [activeId, itemsById, runningIds])

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null)
    const active = itemsById.get(String(event.active.id))
    const runActive = active ? (runningIds?.has(active.unifiedId) ?? false) : false
    const action = resolveIssueDrop(
      String(event.active.id),
      event.over ? String(event.over.id) : null,
      itemsById,
      { runActive }
    )
    if (action) onDrop?.(action)
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={(event: DragStartEvent) => setActiveId(String(event.active.id))}
      onDragCancel={() => setActiveId(null)}
      onDragEnd={handleDragEnd}
    >
      <div
        className="flex h-full min-h-0 gap-3 overflow-x-auto p-3"
        data-testid="issue-board"
        role="list"
      >
        {columns.map((column) => (
          <BoardColumn
            key={column.status}
            status={column.status}
            items={column.items}
            labelsById={labelsById}
            projectNamesById={projectNamesById}
            selectedId={selectedId}
            onSelect={onSelect}
            onAddIssue={onAddIssue}
            dimmed={legalTargets !== null && !legalTargets.has(column.status)}
            emptyText={t("board.empty")}
            statusLabel={t(`status.${column.status}`)}
            addLabel={t("board.addIssue", { status: t(`status.${column.status}`) })}
          />
        ))}
      </div>
    </DndContext>
  )
}

interface BoardColumnProps {
  status: IssueStatus
  items: readonly UnifiedIssueItem[]
  labelsById?: ReadonlyMap<string, LabelRow>
  projectNamesById?: ReadonlyMap<string, string>
  selectedId?: string
  onSelect?: (unifiedId: string) => void
  onAddIssue?: (status: IssueStatus) => void
  dimmed: boolean
  emptyText: string
  statusLabel: string
  addLabel: string
}

function BoardColumn({
  status,
  items,
  labelsById,
  projectNamesById,
  selectedId,
  onSelect,
  onAddIssue,
  dimmed,
  emptyText,
  statusLabel,
  addLabel,
}: BoardColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: columnDropId(status), disabled: dimmed })

  return (
    <section
      ref={setNodeRef}
      role="listitem"
      aria-label={statusLabel}
      data-testid={`issue-column-${status}`}
      data-dimmed={dimmed || undefined}
      className={cn(
        "flex w-72 shrink-0 flex-col rounded-xl border transition-opacity",
        STATUS_COLUMN_TINT[status],
        dimmed && "pointer-events-none opacity-40",
        isOver && !dimmed && "ring-ring/50 ring-2"
      )}
    >
      <header className="flex items-center gap-2 px-3 py-2.5">
        <IssueStatusIcon status={status} />
        <h2 className="text-sm font-semibold">{statusLabel}</h2>
        <span className="text-xs text-muted-foreground tabular-nums">{items.length}</span>
        <span className="flex-1" />
        {onAddIssue ? (
          <Button
            size="icon"
            variant="ghost"
            className="size-6"
            aria-label={addLabel}
            onClick={() => onAddIssue(status)}
            data-testid={`issue-column-add-${status}`}
          >
            <PlusIcon className="size-4" />
          </Button>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        <SortableContext
          items={items.map((item) => item.unifiedId)}
          strategy={verticalListSortingStrategy}
        >
          {items.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">{emptyText}</p>
          ) : (
            items.map((item) => (
              <IssueCard
                key={item.unifiedId}
                item={item}
                labels={item.labelIds
                  .map((id) => labelsById?.get(id))
                  .filter((label): label is LabelRow => Boolean(label))}
                projectName={
                  item.issueProjectId ? projectNamesById?.get(item.issueProjectId) : undefined
                }
                selected={selectedId === item.unifiedId}
                onSelect={onSelect}
              />
            ))
          )}
        </SortableContext>
      </div>
    </section>
  )
}
