// Pure builder that turns the flat `SubagentPart` list on one assistant message
// into a parent→child→grandchild tree for the chat transcript renderer.
//
// PURE function (no React, no store) so the renderer can call it inside a
// `useMemo` over `message.parts` — derived selection, never set-state-in-effect.
// The tree edges come from `parentSubagentId`; depth falls back to `part.depth`.
// Cycles (which the runtime guards against, but which a corrupt transcript could
// still contain) are broken defensively so the walk always terminates and every
// node renders exactly once.

import type { SubagentPart } from "./parts-extensions"
import { isSubagentPart } from "./parts-extensions"

export interface SubagentTreeNode {
  part: SubagentPart
  children: SubagentTreeNode[]
  /** Resolved nesting level (prefers `part.depth`, else computed from the walk). */
  depth: number
}

function stableSort(a: SubagentTreeNode, b: SubagentTreeNode): number {
  return (
    (a.part.startedAt ?? 0) - (b.part.startedAt ?? 0) ||
    a.part.subagentId.localeCompare(b.part.subagentId)
  )
}

/**
 * Build the subagent dispatch tree from a message's parts. Non-subagent parts
 * are ignored. Returns root nodes (runs with no resolvable parent) in stable
 * `startedAt` order; children are nested + sorted the same way.
 */
export function buildSubagentTree(parts: readonly unknown[] | undefined): SubagentTreeNode[] {
  const subagentParts = (Array.isArray(parts) ? parts : []).filter(isSubagentPart)
  if (subagentParts.length === 0) return []

  const nodeById = new Map<string, SubagentTreeNode>()
  for (const p of subagentParts) {
    nodeById.set(p.subagentId, { part: p, children: [], depth: p.depth ?? 0 })
  }

  // Resolve a parent only when it exists in this set and isn't the node itself.
  const parentOf = new Map<string, string>()
  for (const p of subagentParts) {
    const pid = p.parentSubagentId
    if (pid && pid !== p.subagentId && nodeById.has(pid)) parentOf.set(p.subagentId, pid)
  }

  const roots: SubagentTreeNode[] = []
  const visited = new Set<string>()

  const attach = (node: SubagentTreeNode, path: Set<string>, depth: number): void => {
    visited.add(node.part.subagentId)
    node.depth = node.part.depth ?? depth
    const childNodes: SubagentTreeNode[] = []
    for (const p of subagentParts) {
      if (parentOf.get(p.subagentId) !== node.part.subagentId) continue
      if (path.has(p.subagentId)) continue // cycle — don't re-enter
      const child = nodeById.get(p.subagentId)!
      childNodes.push(child)
      attach(child, new Set([...path, node.part.subagentId]), node.depth + 1)
    }
    childNodes.sort(stableSort)
    node.children = childNodes
  }

  for (const p of subagentParts) {
    if (parentOf.has(p.subagentId)) continue // not a root
    const node = nodeById.get(p.subagentId)!
    attach(node, new Set([p.subagentId]), p.depth ?? 1)
    roots.push(node)
  }
  // Nodes trapped in a pure cycle were never reached — surface them as roots so
  // they still render rather than silently vanishing.
  for (const p of subagentParts) {
    if (visited.has(p.subagentId)) continue
    const node = nodeById.get(p.subagentId)!
    attach(node, new Set([p.subagentId]), p.depth ?? 1)
    roots.push(node)
  }

  roots.sort(stableSort)
  return roots
}
