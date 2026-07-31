"use client"

/**
 * A2UI List Component
 * Renders a dynamic list of items with templates
 */

import React, { useMemo, memo, useState, useRef } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { cn } from "@/lib/utils"
import type { A2UIComponentProps, A2UIListComponent } from "@/types/a2ui/schema"
import { useA2UIData, useA2UIActions } from "@/hooks/a2ui"
import { resolveArrayOrPath, getValueByPath } from "@/lib/a2ui/data-model"
import { A2UIChildRenderer } from "../a2ui-child-renderer"
import { getItemKey, getItemDisplayText } from "@/lib/a2ui/list-utils"
import { useA2UIListNavigation } from "@/hooks/a2ui/use-a2ui-keyboard"

/**
 * Lists above this item count switch to windowed rendering so a large
 * agent-generated list (hundreds/thousands of rows) keeps the DOM bounded
 * instead of mounting every item. Smaller lists render inline exactly as
 * before — the common case stays untouched, including all existing tests.
 */
export const LIST_VIRTUALIZE_THRESHOLD = 100
/** Estimated row height (px) used to seed the virtualizer before measurement. */
export const ESTIMATED_LIST_ITEM_HEIGHT = 40

export const A2UIList = memo(function A2UIList({
  component,
  onAction,
}: A2UIComponentProps<A2UIListComponent>) {
  const { dataModel } = useA2UIData()
  const { renderChild } = useA2UIActions()
  const [activeIndex, setActiveIndex] = useState(0)

  const templateDataPath = component.template?.dataPath
  const componentItems = component.items

  // Resolve items from template dataPath, component.items, or empty
  const items = useMemo((): unknown[] => {
    // Template mode: resolve from dataPath
    if (templateDataPath) {
      const resolved = getValueByPath<unknown[]>(dataModel, templateDataPath)
      return Array.isArray(resolved) ? resolved : []
    }
    // Direct items
    if (!componentItems) return []
    if (Array.isArray(componentItems)) {
      return componentItems
    }
    return resolveArrayOrPath(componentItems, dataModel, [])
  }, [componentItems, templateDataPath, dataModel])

  const listNav = useA2UIListNavigation(items, {
    onSelect: (item, index) => {
      if (component.itemClickAction) {
        onAction(component.itemClickAction, { item, index })
      }
    },
    loop: true,
  })

  const handleItemClick = (item: unknown, index: number) => {
    setActiveIndex(index)
    listNav.setActiveIndex(index)
    if (component.itemClickAction) {
      onAction(component.itemClickAction, { item, index })
    }
  }

  // Windowed rendering for large lists. The hook is always called (count 0 when
  // below threshold) to respect the rules of hooks; it is a no-op until the
  // virtualized branch below actually mounts the scroll container.
  const scrollRef = useRef<HTMLDivElement>(null)
  const shouldVirtualize = items.length > LIST_VIRTUALIZE_THRESHOLD
  const virtualizer = useVirtualizer({
    count: shouldVirtualize ? items.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_LIST_ITEM_HEIGHT,
    overscan: 8,
  })

  // Per-item body, shared by the inline and virtualized paths so the three
  // list modes (template / children / simple) render identically either way.
  const renderItemBody = (item: unknown): React.ReactNode => {
    if (component.template?.itemId) {
      return renderChild(component.template.itemId)
    }
    if (component.children && component.children.length > 0) {
      return <A2UIChildRenderer childIds={component.children} />
    }
    return getItemDisplayText(item)
  }

  // Empty state
  if (items.length === 0 && component.emptyText) {
    return (
      <div
        className={cn("py-8 text-center text-sm text-muted-foreground", component.className)}
        style={component.style as React.CSSProperties}
      >
        {component.emptyText}
      </div>
    )
  }

  // Virtualized path for large lists — bounded DOM via @tanstack/react-virtual.
  if (shouldVirtualize) {
    return (
      <div
        ref={scrollRef}
        className={cn("max-h-[480px] overflow-auto", component.className)}
        style={component.style as React.CSSProperties}
        data-testid="a2ui-list-virtualized"
      >
        <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const item = items[virtualRow.index]
            return (
              <div
                key={getItemKey(item, virtualRow.index)}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                className={cn(
                  "absolute top-0 left-0 w-full px-2 py-1",
                  component.itemClickAction &&
                    "cursor-pointer hover:bg-muted/50 rounded-md transition-colors",
                  component.dividers && virtualRow.index > 0 && "border-t"
                )}
                style={{ transform: `translateY(${virtualRow.start}px)` }}
                onClick={() => handleItemClick(item, virtualRow.index)}
              >
                {renderItemBody(item)}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  // Template mode: render the template component for each item
  if (component.template?.itemId) {
    return (
      <div
        className={cn(
          "flex flex-col",
          component.gap ? `gap-${component.gap}` : "gap-2",
          component.className
        )}
        style={component.style as React.CSSProperties}
      >
        {items.map((item, index) => (
          <div
            key={getItemKey(item, index)}
            className={cn(
              component.itemClickAction &&
                "cursor-pointer hover:bg-muted/50 rounded-md transition-colors",
              component.dividers && index > 0 && "border-t pt-2"
            )}
            onClick={() => handleItemClick(item, index)}
          >
            {renderChild(component.template!.itemId)}
          </div>
        ))}
      </div>
    )
  }

  // Children mode: render child components for each item
  if (component.children && component.children.length > 0) {
    return (
      <div
        className={cn(
          "flex flex-col",
          component.gap ? `gap-${component.gap}` : "gap-2",
          component.className
        )}
        style={component.style as React.CSSProperties}
      >
        {items.map((item, index) => (
          <div
            key={getItemKey(item, index)}
            className={cn(
              component.itemClickAction &&
                "cursor-pointer hover:bg-muted/50 rounded-md transition-colors",
              component.dividers && index > 0 && "border-t pt-2"
            )}
            onClick={() => handleItemClick(item, index)}
          >
            <A2UIChildRenderer childIds={component.children!} />
          </div>
        ))}
      </div>
    )
  }

  // Simple list rendering (default)
  return (
    <ul
      className={cn(
        "flex flex-col",
        component.gap ? `gap-${component.gap}` : "gap-1",
        component.ordered && "list-decimal list-inside",
        !component.ordered && "list-disc list-inside",
        component.className
      )}
      style={component.style as React.CSSProperties}
    >
      {items.map((item, index) => (
        <li
          key={getItemKey(item, index)}
          className={cn(
            "px-2 py-1 transition-colors",
            component.itemClickAction && "cursor-pointer hover:bg-muted/50 rounded",
            component.dividers && index > 0 && "border-t",
            activeIndex === index && "bg-accent/50 rounded"
          )}
          onClick={() => handleItemClick(item, index)}
        >
          {getItemDisplayText(item)}
        </li>
      ))}
    </ul>
  )
})
