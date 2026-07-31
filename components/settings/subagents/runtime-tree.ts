/**
 * Groups the flat runtime registry into the parent→child→grandchild shape the
 * nesting policy actually produces.
 *
 * The runtime tab rendered a flat list even though every record carries
 * `depth` and `parentSubagentId`, which made the panel directly above it — the
 * one configuring nested dispatch — impossible to verify from the UI.
 *
 * `components/chat/message-parts/subagent-tree.tsx` renders the same hierarchy
 * for the chat transcript, but consumes message *parts*; this operates on the
 * store's `SubAgent` records. The nesting rule is shared, the input type is
 * not, so only the rule is reused here.
 */

import type { SubAgent, SubAgentStatus } from "@/types/agent/sub-agent"

export interface RuntimeNode {
  run: SubAgent
  depth: number
  children: RuntimeNode[]
}

const TERMINAL: ReadonlySet<SubAgentStatus> = new Set<SubAgentStatus>([
  "completed",
  "failed",
  "cancelled",
  "timeout",
  "rejected",
])

/** True once the run can no longer change on its own. */
export function isTerminal(status: SubAgentStatus): boolean {
  return TERMINAL.has(status)
}

/** True while the run is actually executing (started, not yet finished). */
export function isRunning(run: SubAgent): boolean {
  return (
    !isTerminal(run.status) && run.startedAt instanceof Date && !(run.completedAt instanceof Date)
  )
}

function activityTime(run: SubAgent): number {
  return run.lastActivityAt instanceof Date ? run.lastActivityAt.getTime() : 0
}

function createdTime(run: SubAgent): number {
  return run.createdAt instanceof Date ? run.createdAt.getTime() : 0
}

/**
 * Build the forest. A run whose parent is not in the set becomes a root rather
 * than disappearing — the registry is ephemeral and a parent may already have
 * been cleared, and silently dropping its children would under-report what ran.
 */
export function buildRuntimeTree(runs: readonly SubAgent[]): RuntimeNode[] {
  const byId = new Map(runs.map((r) => [r.id, r]))
  const childrenOf = new Map<string, SubAgent[]>()
  const roots: SubAgent[] = []

  for (const run of runs) {
    const parentId = run.parentSubagentId
    if (parentId && parentId !== run.id && byId.has(parentId)) {
      const bucket = childrenOf.get(parentId)
      if (bucket) bucket.push(run)
      else childrenOf.set(parentId, [run])
    } else {
      roots.push(run)
    }
  }

  // A parent cycle would otherwise recurse forever; each id is placed once.
  const placed = new Set<string>()

  const toNode = (run: SubAgent, depth: number): RuntimeNode => {
    placed.add(run.id)
    const kids = (childrenOf.get(run.id) ?? [])
      .filter((child) => !placed.has(child.id))
      .sort((a, b) => createdTime(a) - createdTime(b))
    return { run, depth, children: kids.map((child) => toNode(child, depth + 1)) }
  }

  const forest = roots
    .sort((a, b) => activityTime(b) - activityTime(a))
    .filter((r) => !placed.has(r.id))
    .map((r) => toNode(r, 0))

  // Anything stranded by a cycle still gets surfaced, at the root.
  for (const run of runs) {
    if (!placed.has(run.id)) forest.push(toNode(run, 0))
  }

  return forest
}

/** Flatten depth-first — the order the rows render in. */
export function flattenRuntimeTree(nodes: readonly RuntimeNode[]): RuntimeNode[] {
  const out: RuntimeNode[] = []
  const walk = (list: readonly RuntimeNode[]) => {
    for (const node of list) {
      out.push(node)
      walk(node.children)
    }
  }
  walk(nodes)
  return out
}

/** Ids of every run that has settled — what "clear finished" removes. */
export function terminalRunIds(runs: readonly SubAgent[]): string[] {
  return runs.filter((r) => isTerminal(r.status)).map((r) => r.id)
}
