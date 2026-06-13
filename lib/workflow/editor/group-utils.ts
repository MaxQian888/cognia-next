/**
 * Group-container helpers (B2) — pure functions over the editor's React Flow
 * node/edge arrays. A group (`annotation.group` typeVersion 2) hosts its
 * members via `parentId`; these resolve the membership and the in-group entry
 * points used by the "Run this block" action.
 *
 * Kept framework-free (plain arrays) so they're trivially unit-testable and
 * reusable by the selection toolbar, context menu, and tests alike.
 */

interface NodeLike {
  id: string
  parentId?: string
  data?: { kind?: unknown }
}
interface EdgeLike {
  source: string
  target: string
}

/** Direct child node ids of a group (one level — not transitive). */
export function groupChildIds(nodes: ReadonlyArray<NodeLike>, groupId: string): string[] {
  return nodes.filter((n) => n.parentId === groupId).map((n) => n.id)
}

/** Whether a node is a group container (annotation.group). */
export function isGroupContainer(node: NodeLike | undefined): boolean {
  return node?.data?.kind === "annotation.group"
}

/**
 * The "entry" children of a group: members with no inbound edge from another
 * member of the SAME group. Running the block starts here (every other member
 * is reachable downstream). Falls back to all children when the group has no
 * internal edges (each member is its own entry).
 */
export function groupEntryChildIds(
  nodes: ReadonlyArray<NodeLike>,
  edges: ReadonlyArray<EdgeLike>,
  groupId: string
): string[] {
  const children = groupChildIds(nodes, groupId)
  if (children.length === 0) return []
  const childSet = new Set(children)
  const hasInternalInbound = new Set<string>()
  for (const e of edges) {
    if (childSet.has(e.source) && childSet.has(e.target)) {
      hasInternalInbound.add(e.target)
    }
  }
  const entries = children.filter((id) => !hasInternalInbound.has(id))
  return entries.length > 0 ? entries : children
}
