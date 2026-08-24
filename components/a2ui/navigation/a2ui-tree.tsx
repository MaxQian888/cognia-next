"use client"

/**
 * A2UI Tree component.
 *
 * The catalog's only hierarchical navigator was `Sidebar`, which is fixed at
 * two levels (group → item) and carries chrome — a `SidebarProvider`, header
 * and footer — that a panel body does not want. A repository outline, an
 * outline of headings, or any nested index needs arbitrary depth, so this is a
 * separate component rather than a fourth nesting level bolted onto Sidebar.
 *
 * Nodes are plain data, not component references: `nodes[].children` holds more
 * nodes, never component ids. That keeps the tree out of the component-tree
 * structural graph (`getComponentChildReferences` only walks `tabs`/`items`
 * children and `steps` content), so a deep outline costs one component instead
 * of one per row.
 *
 * Expansion is local state. A plugin that wants to lazy-load a branch declares
 * `expandAction` and pushes the resolved children back through the data model.
 */

import React, { memo, useCallback, useMemo, useState } from "react"
import { ChevronRight } from "lucide-react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { resolveIcon } from "@/lib/a2ui/resolve-icon"
import type { A2UIComponentProps } from "@/types/a2ui/schema"
import type { A2UITreeComponent, A2UITreeNode } from "@/types/artifact/a2ui"
import { useA2UIData } from "../a2ui-context"

export type { A2UITreeComponent, A2UITreeNode }

/** Ids expanded on first render, from per-node overrides then depth. */
function initialExpandedIds(
  nodes: readonly A2UITreeNode[],
  depth: number,
  level = 0,
  collected: Set<string> = new Set()
): Set<string> {
  for (const node of nodes) {
    if (!node.children?.length) continue
    if (node.defaultExpanded ?? level < depth) collected.add(node.id)
    initialExpandedIds(node.children, depth, level + 1, collected)
  }
  return collected
}

interface TreeNodeRowProps {
  node: A2UITreeNode
  level: number
  expanded: ReadonlySet<string>
  selectedId: string
  onToggle: (node: A2UITreeNode) => void
  onSelect: (node: A2UITreeNode) => void
  expandLabel: string
  collapseLabel: string
}

const TreeNodeRow = memo(function TreeNodeRow({
  node,
  level,
  expanded,
  selectedId,
  onToggle,
  onSelect,
  expandLabel,
  collapseLabel,
}: TreeNodeRowProps) {
  const children = node.children ?? []
  const hasChildren = children.length > 0
  const isExpanded = hasChildren && expanded.has(node.id)
  const Icon = resolveIcon(node.icon)

  return (
    <li role="none">
      <div
        role="treeitem"
        aria-level={level + 1}
        aria-selected={selectedId === node.id}
        aria-expanded={hasChildren ? isExpanded : undefined}
        aria-disabled={node.disabled || undefined}
        className={cn(
          "flex items-center gap-1 rounded-md py-1 pr-2 text-sm",
          node.disabled ? "opacity-50" : "hover:bg-accent/60",
          selectedId === node.id && "bg-accent text-accent-foreground"
        )}
        style={{ paddingLeft: `${level * 12 + 4}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={isExpanded ? collapseLabel : expandLabel}
            className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
            onClick={() => onToggle(node)}
          >
            <ChevronRight
              className={cn("size-3.5 transition-transform", isExpanded && "rotate-90")}
            />
          </button>
        ) : (
          <span className="size-4 shrink-0" />
        )}
        <button
          type="button"
          disabled={node.disabled}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          onClick={() => onSelect(node)}
        >
          {Icon && <Icon className="size-3.5 shrink-0 text-muted-foreground" />}
          <span className="truncate">{node.label}</span>
        </button>
        {node.badge && <span className="shrink-0 text-xs text-muted-foreground">{node.badge}</span>}
      </div>
      {isExpanded && (
        <ul role="group" className="list-none">
          {children.map((child) => (
            <TreeNodeRow
              key={child.id}
              node={child}
              level={level + 1}
              expanded={expanded}
              selectedId={selectedId}
              onToggle={onToggle}
              onSelect={onSelect}
              expandLabel={expandLabel}
              collapseLabel={collapseLabel}
            />
          ))}
        </ul>
      )}
    </li>
  )
})

export const A2UITree = memo(function A2UITree({
  component,
  onAction,
}: A2UIComponentProps<A2UITreeComponent>) {
  const t = useTranslations("a2ui")
  const { resolveString } = useA2UIData()
  const nodes = useMemo(() => component.nodes ?? [], [component.nodes])
  const selectedId = resolveString(component.selectedId ?? "", "")

  const [expanded, setExpanded] = useState<Set<string>>(() =>
    initialExpandedIds(nodes, component.defaultExpandedDepth ?? 1)
  )

  const expandAction = component.expandAction
  const selectAction = component.action

  const handleToggle = useCallback(
    (node: A2UITreeNode) => {
      let nowExpanded = false
      setExpanded((previous) => {
        const next = new Set(previous)
        if (next.has(node.id)) {
          next.delete(node.id)
        } else {
          next.add(node.id)
          nowExpanded = true
        }
        return next
      })
      if (expandAction) onAction(expandAction, { nodeId: node.id, expanded: nowExpanded })
    },
    [expandAction, onAction]
  )

  const handleSelect = useCallback(
    (node: A2UITreeNode) => {
      if (node.disabled) return
      if (selectAction) onAction(selectAction, { nodeId: node.id })
      // A branch with no select action still toggles — otherwise clicking a
      // folder label does nothing, which reads as a broken row.
      else if (node.children?.length) handleToggle(node)
    },
    [handleToggle, onAction, selectAction]
  )

  if (nodes.length === 0) {
    return (
      <p
        className={cn("px-2 py-1.5 text-sm text-muted-foreground", component.className)}
        style={component.style as React.CSSProperties}
      >
        {component.emptyLabel ?? t("treeEmpty")}
      </p>
    )
  }

  return (
    <ul
      role="tree"
      className={cn("list-none select-none", component.className)}
      style={component.style as React.CSSProperties}
    >
      {nodes.map((node) => (
        <TreeNodeRow
          key={node.id}
          node={node}
          level={0}
          expanded={expanded}
          selectedId={selectedId}
          onToggle={handleToggle}
          onSelect={handleSelect}
          expandLabel={t("treeExpand")}
          collapseLabel={t("treeCollapse")}
        />
      ))}
    </ul>
  )
})
