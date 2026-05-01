"use client"

/**
 * A2UI List Component
 * Renders a dynamic list of items with templates
 */

import React, { useMemo, memo, useState } from "react"
import { cn } from "@/lib/utils"
import type { A2UIComponentProps, A2UIListComponent } from "@/types/a2ui/schema"
import { useA2UIData, useA2UIActions } from "@/hooks/a2ui"
import { resolveArrayOrPath, getValueByPath } from "@/lib/a2ui/data-model"
import { A2UIChildRenderer } from "../a2ui-renderer"
import { getItemKey, getItemDisplayText } from "@/lib/a2ui/list-utils"
import { useA2UIListNavigation } from "@/hooks/a2ui/use-a2ui-keyboard"

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
