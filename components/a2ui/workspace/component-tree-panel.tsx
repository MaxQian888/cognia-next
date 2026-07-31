"use client"

/**
 * Component Tree Panel
 * Recursive tree view of the A2UI surface component hierarchy
 */

import React, { useCallback } from "react"
import { useTranslations } from "next-intl"
import {
  Type,
  Square,
  Columns,
  Rows,
  List,
  Image as ImageIcon,
  BarChart3,
  Table2,
  ToggleLeft,
  TextCursorInput,
  ChevronRight,
  MousePointerClick,
  Layout,
  CopyPlus,
  Trash2,
  Plus,
  Move as MoveIcon,
} from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useA2UIStore } from "@/stores/a2ui"
import { cn } from "@/lib/utils"
import {
  collectComponentSubtreeIds,
  getComponentChildReferences,
  getComponentCollectionSlots,
  type A2UIComponentPlacement,
} from "@/lib/a2ui/component-tree"
import { getRegisteredTypes, getStandardComponentTypes } from "@/lib/a2ui/catalog"
import type { A2UIComponent } from "@/types/a2ui/schema"
import { useWorkspaceContext } from "./a2ui-workspace-context"
import { ComponentPlacementDialog } from "./component-placement-dialog"

const COMPONENT_ICONS: Record<string, React.ReactNode> = {
  Text: <Type className="h-3.5 w-3.5" />,
  Button: <MousePointerClick className="h-3.5 w-3.5" />,
  TextField: <TextCursorInput className="h-3.5 w-3.5" />,
  TextArea: <TextCursorInput className="h-3.5 w-3.5" />,
  Select: <ToggleLeft className="h-3.5 w-3.5" />,
  Card: <Square className="h-3.5 w-3.5" />,
  Row: <Columns className="h-3.5 w-3.5" />,
  Column: <Rows className="h-3.5 w-3.5" />,
  List: <List className="h-3.5 w-3.5" />,
  Image: <ImageIcon className="h-3.5 w-3.5" />,
  Chart: <BarChart3 className="h-3.5 w-3.5" />,
  Table: <Table2 className="h-3.5 w-3.5" />,
}

/** Locate a component's current collection placement (parent + slot + index). */
function findComponentPlacement(
  components: Record<string, A2UIComponent>,
  childId: string
): A2UIComponentPlacement | null {
  for (const [parentId, component] of Object.entries(components)) {
    for (const slot of getComponentCollectionSlots(component)) {
      const index = slot.childIds.indexOf(childId)
      if (index >= 0) return { parentId, slotId: slot.id, index }
    }
  }
  return null
}

interface TreeNodeProps {
  componentId: string
  components: Record<string, A2UIComponent>
  depth: number
  selectedId: string | null
  onSelect: (id: string) => void
  expandedIds: Set<string>
  onToggleExpand: (id: string) => void
  ancestorIds: ReadonlySet<string>
  expandLabel: string
  collapseLabel: string
  /** This node's placement in its parent. Undefined for the root / required
   *  (non-collection) children — those are not drag-reorderable. */
  placement?: A2UIComponentPlacement
  draggingId: string | null
  dragOverId: string | null
  dropAfter: boolean
  onDragStartNode: (id: string) => void
  onDragOverNode: (id: string, after: boolean) => void
  onDragEndNode: () => void
  onDropNode: (target: A2UIComponentPlacement, after: boolean) => void
}

function TreeNode({
  componentId,
  components,
  depth,
  selectedId,
  onSelect,
  expandedIds,
  onToggleExpand,
  ancestorIds,
  expandLabel,
  collapseLabel,
  placement,
  draggingId,
  dragOverId,
  dropAfter,
  onDragStartNode,
  onDragOverNode,
  onDragEndNode,
  onDropNode,
}: TreeNodeProps) {
  const component = components[componentId]
  if (!component || ancestorIds.has(componentId)) return null

  const children = getComponentChildReferences(component).map((reference) => reference.id)
  // Per-child collection placement (parent + slot + index). Only collection
  // children are drag-reorderable; required children (trigger/template) are not.
  const childPlacements = new Map<string, A2UIComponentPlacement>()
  for (const slot of getComponentCollectionSlots(component)) {
    slot.childIds.forEach((childId, index) => {
      childPlacements.set(childId, { parentId: componentId, slotId: slot.id, index })
    })
  }
  const hasChildren = children.length > 0
  const isExpanded = expandedIds.has(componentId)
  const isSelected = selectedId === componentId
  const icon = COMPONENT_ICONS[component.component] || <Layout className="h-3.5 w-3.5" />

  return (
    <div>
      <div
        role="treeitem"
        tabIndex={0}
        aria-selected={isSelected}
        aria-expanded={hasChildren ? isExpanded : undefined}
        draggable={Boolean(placement)}
        className={cn(
          "flex items-center gap-1 px-2 py-1 text-xs cursor-pointer rounded-sm transition-colors",
          "hover:bg-accent/50",
          isSelected && "bg-accent text-accent-foreground",
          draggingId === componentId && "opacity-50",
          dragOverId === componentId &&
            (dropAfter ? "border-b-2 border-primary" : "border-t-2 border-primary")
        )}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onClick={() => onSelect(componentId)}
        onDragStart={(event) => {
          if (!placement) return
          event.stopPropagation()
          onDragStartNode(componentId)
        }}
        onDragEnd={() => onDragEndNode()}
        onDragOver={(event) => {
          if (!placement || !draggingId || draggingId === componentId) return
          event.preventDefault()
          const rect = event.currentTarget.getBoundingClientRect()
          onDragOverNode(componentId, event.clientY > rect.top + rect.height / 2)
        }}
        onDrop={(event) => {
          if (!placement || !draggingId || draggingId === componentId) return
          event.preventDefault()
          event.stopPropagation()
          const rect = event.currentTarget.getBoundingClientRect()
          onDropNode(placement, event.clientY > rect.top + rect.height / 2)
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault()
            onSelect(componentId)
          }
        }}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={isExpanded ? collapseLabel : expandLabel}
            className="shrink-0 p-0.5 hover:bg-accent/80 rounded-xs"
            onClick={(e) => {
              e.stopPropagation()
              onToggleExpand(componentId)
            }}
          >
            <ChevronRight
              className={cn(
                "h-3 w-3 transition-transform duration-200 motion-reduce:transition-none",
                isExpanded && "rotate-90"
              )}
            />
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <span className="text-muted-foreground shrink-0">{icon}</span>
        <span className="truncate font-mono">{component.component}</span>
        <span className="text-muted-foreground/60 truncate ml-auto text-[10px]">
          {componentId.slice(0, 8)}
        </span>
      </div>
      {hasChildren && isExpanded && (
        <div>
          {children.map((childId: string) => (
            <TreeNode
              key={childId}
              componentId={childId}
              components={components}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
              expandedIds={expandedIds}
              onToggleExpand={onToggleExpand}
              ancestorIds={new Set([...ancestorIds, componentId])}
              expandLabel={expandLabel}
              collapseLabel={collapseLabel}
              placement={childPlacements.get(childId)}
              draggingId={draggingId}
              dragOverId={dragOverId}
              dropAfter={dropAfter}
              onDragStartNode={onDragStartNode}
              onDragOverNode={onDragOverNode}
              onDragEndNode={onDragEndNode}
              onDropNode={onDropNode}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export interface ComponentTreePanelProps {
  canDeleteSelected?: boolean
  canDuplicateSelected?: boolean
  onDeleteSelected?: () => void
  onDuplicateSelected?: () => void
  onAddComponent?: (type: string, placement: A2UIComponentPlacement) => boolean
  onAddComponentToRoot?: (type: string) => boolean
  onMoveSelected?: (placement: A2UIComponentPlacement) => boolean
}

export function ComponentTreePanel({
  canDeleteSelected = false,
  canDuplicateSelected = false,
  onDeleteSelected,
  onDuplicateSelected,
  onAddComponent,
  onAddComponentToRoot,
  onMoveSelected,
}: ComponentTreePanelProps) {
  const t = useTranslations("a2ui")
  const { surfaceId, selectedComponentId, setSelectedComponentId } = useWorkspaceContext()
  const surface = useA2UIStore((state) => state.surfaces[surfaceId])
  const moveComponent = useA2UIStore((state) => state.moveComponent)
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(() =>
    surface?.rootId ? new Set([surface.rootId]) : new Set()
  )
  const [dialogMode, setDialogMode] = React.useState<"add" | "move" | null>(null)
  const [draggingId, setDraggingId] = React.useState<string | null>(null)
  const [dragOverId, setDragOverId] = React.useState<string | null>(null)
  const [dropAfter, setDropAfter] = React.useState(false)

  const handleDragStartNode = React.useCallback((id: string) => setDraggingId(id), [])
  const handleDragOverNode = React.useCallback((id: string, after: boolean) => {
    setDragOverId(id)
    setDropAfter(after)
  }, [])
  const handleDragEndNode = React.useCallback(() => {
    setDraggingId(null)
    setDragOverId(null)
  }, [])
  const handleDropNode = React.useCallback(
    (target: A2UIComponentPlacement, after: boolean) => {
      const dragged = draggingId
      setDraggingId(null)
      setDragOverId(null)
      if (!dragged || !surface) return
      // Base index: before the target, or after it (top/bottom drop half).
      let index = (target.index ?? 0) + (after ? 1 : 0)
      // Reordering DOWN within the same slot detaches the dragged node first,
      // shifting the target's index down by one.
      const from = findComponentPlacement(surface.components, dragged)
      if (
        from &&
        from.parentId === target.parentId &&
        from.slotId === target.slotId &&
        from.index !== undefined &&
        from.index < index
      ) {
        index -= 1
      }
      const moved = moveComponent(surfaceId, dragged, {
        parentId: target.parentId,
        slotId: target.slotId,
        index,
      })
      if (moved) {
        setSelectedComponentId(dragged)
        setExpandedIds((current) => new Set(current).add(target.parentId))
      }
    },
    [draggingId, moveComponent, surface, surfaceId, setSelectedComponentId]
  )
  // Reset expanded set when the surface root changes — adjust during render
  // per React docs (https://react.dev/reference/react/useState#storing-information-from-previous-renders).
  const [trackedRootId, setTrackedRootId] = React.useState<string | undefined>(surface?.rootId)
  if (surface?.rootId !== trackedRootId) {
    setTrackedRootId(surface?.rootId)
    setExpandedIds(surface?.rootId ? new Set([surface.rootId]) : new Set())
  }

  const handleToggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const componentTypes = React.useMemo(
    () =>
      Array.from(
        new Set([...getStandardComponentTypes(), ...getRegisteredTypes(surface?.catalogId)])
      ).sort((left, right) => left.localeCompare(right)),
    [surface?.catalogId]
  )
  const canAdd = Boolean(surface && (onAddComponent || onAddComponentToRoot))
  const canMove = React.useMemo(() => {
    if (!surface || !selectedComponentId || selectedComponentId === surface.rootId) return false
    const subtree = collectComponentSubtreeIds(surface.components, selectedComponentId)
    return Object.entries(surface.components).some(
      ([id, component]) => !subtree.has(id) && getComponentCollectionSlots(component).length > 0
    )
  }, [selectedComponentId, surface])

  if (!surface) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm p-4">
        {t("noSurfaceLoaded")}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        <span className="min-w-0 flex-1 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {t("componentTree")}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t("addComponent")}
              disabled={!canAdd}
              onClick={() => setDialogMode("add")}
            >
              <Plus data-icon="inline-start" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("addComponent")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t("moveComponent")}
              disabled={!canMove || !onMoveSelected}
              onClick={() => setDialogMode("move")}
            >
              <MoveIcon data-icon="inline-start" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("moveComponent")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t("duplicateComponent")}
              disabled={!canDuplicateSelected}
              onClick={onDuplicateSelected}
            >
              <CopyPlus data-icon="inline-start" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("duplicateComponent")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="text-destructive hover:text-destructive"
              aria-label={t("deleteComponent")}
              disabled={!canDeleteSelected}
              onClick={onDeleteSelected}
            >
              <Trash2 data-icon="inline-start" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("deleteComponent")}</TooltipContent>
        </Tooltip>
      </div>
      <ScrollArea className="flex-1">
        <div className="py-1" role="tree">
          {surface.rootId && (
            <TreeNode
              componentId={surface.rootId}
              components={surface.components}
              depth={0}
              selectedId={selectedComponentId}
              onSelect={setSelectedComponentId}
              expandedIds={expandedIds}
              onToggleExpand={handleToggleExpand}
              ancestorIds={new Set()}
              expandLabel={t("expandComponent")}
              collapseLabel={t("collapseComponent")}
              draggingId={draggingId}
              dragOverId={dragOverId}
              dropAfter={dropAfter}
              onDragStartNode={handleDragStartNode}
              onDragOverNode={handleDragOverNode}
              onDragEndNode={handleDragEndNode}
              onDropNode={handleDropNode}
            />
          )}
        </div>
      </ScrollArea>
      {dialogMode && (
        <ComponentPlacementDialog
          mode={dialogMode}
          components={surface.components}
          componentTypes={componentTypes}
          componentId={selectedComponentId ?? undefined}
          onOpenChange={(open) => {
            if (!open) setDialogMode(null)
          }}
          onAdd={(type, placement) => {
            const added = onAddComponent?.(type, placement) ?? false
            if (added) {
              setExpandedIds((current) => new Set(current).add(placement.parentId))
            }
            return added
          }}
          onAddToRoot={(type) => onAddComponentToRoot?.(type) ?? false}
          onMove={(placement) => {
            const moved = onMoveSelected?.(placement) ?? false
            if (moved) {
              setExpandedIds((current) => new Set(current).add(placement.parentId))
            }
            return moved
          }}
        />
      )}
    </div>
  )
}
