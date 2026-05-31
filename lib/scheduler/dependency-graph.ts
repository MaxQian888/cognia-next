/**
 * Build a renderable dependency graph from scheduled tasks.
 *
 * Each task's `trigger.dependsOn[]` lists the upstream task ids that must
 * complete before it runs (the runtime behaviour lives in
 * `task-scheduler.ts:triggerDependentTasks`). This module turns those links
 * into nodes + edges with topological layering (longest-path Kahn) and cycle
 * detection, ready for the lightweight SVG renderer.
 *
 * Two modes:
 *   - full graph    → every task that has at least one dependency link.
 *   - neighborhood  → a focus task plus its direct upstream + downstream.
 *
 * Dangling `dependsOn` ids (referencing a deleted task) are ignored.
 */

import type { ScheduledTask } from "@/types/scheduler"
import type { DependencyEdge, DependencyGraph, DependencyNode } from "@/types/scheduler/dependency"

export interface BuildDependencyGraphOptions {
  /** When set, restrict the graph to this task + its direct upstream/downstream. */
  focusTaskId?: string
}

export function buildDependencyGraph(
  tasks: ScheduledTask[],
  options: BuildDependencyGraphOptions = {}
): DependencyGraph {
  const byId = new Map(tasks.map((t) => [t.id, t]))

  // All valid edges (both endpoints exist): upstream -> downstream.
  const allEdges: { from: string; to: string }[] = []
  for (const task of tasks) {
    const deps = task.trigger.dependsOn
    if (!deps) continue
    for (const upstream of deps) {
      if (upstream === task.id) continue // self-loop: ignore as a link
      if (byId.has(upstream)) allEdges.push({ from: upstream, to: task.id })
    }
  }

  // Decide which node ids are in scope.
  let nodeIds: Set<string>
  if (options.focusTaskId && byId.has(options.focusTaskId)) {
    const focus = options.focusTaskId
    nodeIds = new Set<string>([focus])
    for (const e of allEdges) {
      if (e.to === focus) nodeIds.add(e.from) // direct upstream
      if (e.from === focus) nodeIds.add(e.to) // direct downstream
    }
  } else {
    // Full graph: every task touched by at least one edge.
    nodeIds = new Set<string>()
    for (const e of allEdges) {
      nodeIds.add(e.from)
      nodeIds.add(e.to)
    }
  }

  const edges = allEdges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to))

  // Longest-path layering via Kahn over the in-scope subgraph.
  const indegree = new Map<string, number>()
  const outgoing = new Map<string, string[]>()
  for (const id of nodeIds) {
    indegree.set(id, 0)
    outgoing.set(id, [])
  }
  for (const e of edges) {
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1)
    outgoing.get(e.from)!.push(e.to)
  }

  const level = new Map<string, number>()
  const queue: string[] = []
  for (const id of nodeIds) {
    if ((indegree.get(id) ?? 0) === 0) {
      level.set(id, 0)
      queue.push(id)
    }
  }
  let processed = 0
  while (queue.length > 0) {
    const u = queue.shift()!
    processed++
    const lu = level.get(u) ?? 0
    for (const v of outgoing.get(u) ?? []) {
      level.set(v, Math.max(level.get(v) ?? 0, lu + 1))
      const d = (indegree.get(v) ?? 0) - 1
      indegree.set(v, d)
      if (d === 0) queue.push(v)
    }
  }

  // Nodes never settled by Kahn are stuck on a cycle.
  const cycleNodeIds: string[] = []
  if (processed < nodeIds.size) {
    for (const id of nodeIds) {
      if (!level.has(id)) {
        cycleNodeIds.push(id)
        level.set(id, 0) // park cycle nodes in column 0 so they still render
      }
    }
  }
  const cycleSet = new Set(cycleNodeIds)

  const nodes: DependencyNode[] = [...nodeIds].map((id) => {
    const task = byId.get(id)!
    return {
      id,
      name: task.name,
      type: task.type,
      status: task.status,
      level: level.get(id) ?? 0,
      inCycle: cycleSet.has(id),
    }
  })

  // Stable ordering: by level, then name, then id.
  nodes.sort(
    (a, b) => a.level - b.level || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  )

  const decoratedEdges: DependencyEdge[] = edges.map((e) => ({
    from: e.from,
    to: e.to,
    inCycle: cycleSet.has(e.from) && cycleSet.has(e.to),
  }))

  const levelCount = nodes.reduce((max, n) => Math.max(max, n.level + 1), 0)

  return {
    nodes,
    edges: decoratedEdges,
    levelCount,
    cycleNodeIds,
    hasCycle: cycleNodeIds.length > 0,
  }
}

/**
 * Whether a task is connected to any dependency link (depends on something, or
 * is depended upon). Used to decide if the detail-view "Dependencies" card
 * should appear at all.
 */
export function hasDependencyLinks(task: ScheduledTask, allTasks: ScheduledTask[]): boolean {
  const ids = new Set(allTasks.map((t) => t.id))
  const upstream = (task.trigger.dependsOn ?? []).some((id) => id !== task.id && ids.has(id))
  if (upstream) return true
  return allTasks.some((t) => t.id !== task.id && (t.trigger.dependsOn ?? []).includes(task.id))
}
