/**
 * Task dependency graph model.
 *
 * Derived from each task's `trigger.dependsOn[]` (see
 * `lib/scheduler/task-scheduler.ts` `triggerDependentTasks` for the runtime
 * semantics these edges visualize: a downstream task fires once all its
 * upstream dependencies complete successfully).
 */

import type { ScheduledTaskStatus, ScheduledTaskType } from "./index"

export interface DependencyNode {
  id: string
  name: string
  type: ScheduledTaskType
  status: ScheduledTaskStatus
  /** Topological layer (0 = no in-graph upstream). Columns in the SVG layout. */
  level: number
  /** True when this node participates in a dependency cycle. */
  inCycle: boolean
}

export interface DependencyEdge {
  /** Upstream task id — must complete before `to` runs. */
  from: string
  /** Downstream task id — depends on `from`. */
  to: string
  /** True when both endpoints sit on a cycle (rendered in red). */
  inCycle: boolean
}

export interface DependencyGraph {
  nodes: DependencyNode[]
  edges: DependencyEdge[]
  /** Number of topological layers (columns). */
  levelCount: number
  /** Task ids involved in at least one cycle. */
  cycleNodeIds: string[]
  hasCycle: boolean
}
