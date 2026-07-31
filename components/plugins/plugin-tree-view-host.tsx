"use client"

// Renders a plugin `TreeDataProvider` (B2) as an interactive tree: lazy child
// loading on expand, refresh on `onDidChangeTreeData`, and command dispatch on
// node click. `PluginViewHost` owns the shared surface boundary so a throwing
// provider cannot take down the host.

import { useCallback, useEffect, useMemo, useState } from "react"
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { PluginTreeNode, TreeDataProvider } from "@/types/plugin/plugin-view"
import { executeCommand } from "@/lib/plugin/commands/registry"
import { loggers } from "@cognia/logging"
import { ResolvedRailIcon } from "@/components/shell/plugin-view-container-panel"

const ROOT = "__root__"

interface Props {
  provider: TreeDataProvider
  /** Owning plugin id (for command-dispatch diagnostics). */
  pluginId: string
}

export function PluginTreeViewHost({ provider, pluginId }: Props) {
  // children[parentId] = the loaded children of that node (ROOT for top level).
  const [children, setChildren] = useState<Record<string, PluginTreeNode[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // Bumped to force a full reload when the provider signals a change.
  const [revision, setRevision] = useState(0)

  const loadChildren = useCallback(
    async (parentId: string | undefined) => {
      try {
        const nodes = await provider.getChildren(parentId)
        // A root load (parentId === undefined) replaces the whole cache so a
        // refresh drops stale expanded children; a child load merges in.
        setChildren((prev) =>
          parentId === undefined ? { [ROOT]: nodes } : { ...prev, [parentId]: nodes }
        )
      } catch (err) {
        loggers.plugin.warn("tree view getChildren failed", {
          pluginId,
          parentId,
          error: String(err),
        })
        setChildren((prev) =>
          parentId === undefined ? { [ROOT]: [] } : { ...prev, [parentId]: [] }
        )
      }
    },
    [provider, pluginId]
  )

  // Load roots on mount + whenever the provider signals a data change. The
  // setState happens inside the async loadChildren (genuine async data fetch,
  // not effect-mirrored state) — the established repo pattern for this.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadChildren(undefined)
  }, [loadChildren, revision])

  // Subscribe to provider change events (optional API).
  useEffect(() => {
    if (!provider.onDidChangeTreeData) return
    const off = provider.onDidChangeTreeData(() => setRevision((r) => r + 1))
    return off
  }, [provider])

  const toggle = useCallback(
    (node: PluginTreeNode) => {
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(node.id)) {
          next.delete(node.id)
        } else {
          next.add(node.id)
          if (!children[node.id]) void loadChildren(node.id)
        }
        return next
      })
    },
    [children, loadChildren]
  )

  const handleClick = useCallback(
    (node: PluginTreeNode) => {
      if (node.expandable) toggle(node)
      if (node.command) {
        executeCommand(node.command).catch((err) =>
          loggers.plugin.warn("tree view command dispatch failed", {
            pluginId,
            command: node.command,
            error: String(err),
          })
        )
      }
    },
    [toggle, pluginId]
  )

  const roots = useMemo(() => children[ROOT] ?? [], [children])

  return (
    <ul className="flex flex-col py-1" role="tree" data-plugin-tree-view={pluginId}>
      {roots.map((node) => (
        <TreeRow
          key={node.id}
          node={node}
          depth={0}
          expanded={expanded}
          childMap={children}
          onClick={handleClick}
        />
      ))}
    </ul>
  )
}

interface RowProps {
  node: PluginTreeNode
  depth: number
  expanded: Set<string>
  childMap: Record<string, PluginTreeNode[]>
  onClick: (node: PluginTreeNode) => void
}

function TreeRow({ node, depth, expanded, childMap, onClick }: RowProps) {
  const isExpanded = expanded.has(node.id)
  const kids = childMap[node.id]
  return (
    <li
      role="treeitem"
      aria-selected={false}
      aria-expanded={node.expandable ? isExpanded : undefined}
    >
      <button
        type="button"
        onClick={() => onClick(node)}
        className={cn(
          "flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm hover:bg-accent"
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        data-tree-node={node.id}
      >
        {node.expandable ? (
          isExpanded ? (
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="inline-block size-3.5 shrink-0" />
        )}
        {node.icon && (
          <ResolvedRailIcon name={node.icon} className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate">{node.label}</span>
      </button>
      {node.expandable && isExpanded && kids && (
        <ul role="group" className="flex flex-col">
          {kids.map((child) => (
            <TreeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              childMap={childMap}
              onClick={onClick}
            />
          ))}
        </ul>
      )}
    </li>
  )
}
