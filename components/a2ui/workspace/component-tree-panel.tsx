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
  ChevronDown,
  MousePointerClick,
  Layout,
} from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useA2UIStore } from "@/stores/a2ui"
import { cn } from "@/lib/utils"
import type { A2UIComponent } from "@/types/a2ui/schema"
import { useWorkspaceContext } from "./a2ui-workspace-context"

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

interface TreeNodeProps {
  componentId: string
  components: Record<string, A2UIComponent>
  depth: number
  selectedId: string | null
  onSelect: (id: string) => void
  expandedIds: Set<string>
  onToggleExpand: (id: string) => void
}

function TreeNode({
  componentId,
  components,
  depth,
  selectedId,
  onSelect,
  expandedIds,
  onToggleExpand,
}: TreeNodeProps) {
  const component = components[componentId]
  if (!component) return null

  const children =
    "children" in component && Array.isArray(component.children) ? component.children : []
  const hasChildren = children.length > 0
  const isExpanded = expandedIds.has(componentId)
  const isSelected = selectedId === componentId
  const icon = COMPONENT_ICONS[component.component] || <Layout className="h-3.5 w-3.5" />

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-1 px-2 py-1 text-xs cursor-pointer rounded-sm transition-colors",
          "hover:bg-accent/50",
          isSelected && "bg-accent text-accent-foreground"
        )}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onClick={() => onSelect(componentId)}
      >
        {hasChildren ? (
          <button
            className="shrink-0 p-0.5 hover:bg-accent/80 rounded-xs"
            onClick={(e) => {
              e.stopPropagation()
              onToggleExpand(componentId)
            }}
          >
            {isExpanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
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
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function ComponentTreePanel() {
  const t = useTranslations("a2ui")
  const { surfaceId, selectedComponentId, setSelectedComponentId } = useWorkspaceContext()
  const surface = useA2UIStore((state) => state.surfaces[surfaceId])
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(() =>
    surface?.rootId ? new Set([surface.rootId]) : new Set()
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

  if (!surface) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm p-4">
        No surface loaded
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b text-xs font-medium text-muted-foreground uppercase tracking-wider">
        {t("componentTree")}
      </div>
      <ScrollArea className="flex-1">
        <div className="py-1">
          {surface.rootId && (
            <TreeNode
              componentId={surface.rootId}
              components={surface.components}
              depth={0}
              selectedId={selectedComponentId}
              onSelect={setSelectedComponentId}
              expandedIds={expandedIds}
              onToggleExpand={handleToggleExpand}
            />
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
