/**
 * Translate an AgentTeam + its tasks into a runnable VisualWorkflow whose
 * nodes are `action.team.task.dispatch` instances and whose edges encode the
 * `task.dependencies` DAG. The synthesized workflow is fed to runWorkflow.
 *
 * Per ADR-0022 §3.5. The synthesizer is pure (no Dexie / no executeAgent /
 * no abort signal) — it only shapes types. Validates non-empty input,
 * dep id references, and absence of cycles (Kahn's algorithm).
 *
 * Synthesized workflow id has the `__team__:<teamId>:<nonce>` prefix; the
 * UI must not attempt to load a workflow definition for this id. The full
 * snapshot lives on the workflowRuns row.
 */

import { nanoid } from "nanoid"
import type { AgentTeam, AgentTeamTask } from "@/types/agent/agent-team"
import { DEFAULT_RETRY_POLICY } from "@/types/workflow/visual"
import type { VisualWorkflow, WorkflowEdge, WorkflowNode } from "@/types/workflow/visual"

export interface SynthesizeInput {
  team: AgentTeam
  tasks: AgentTeamTask[]
  initialConcurrency: number
  wallClockTimeoutMs?: number
  /** Forwarded into node executor via TeamRunContext; not encoded into VW. */
  perTaskTimeoutMs?: number
}

export interface SynthesizeResult {
  workflow: VisualWorkflow
  nodeIdToTaskId: Map<string, string>
}

export class SynthesizeError extends Error {
  constructor(
    public readonly reason: "cycle" | "empty" | "invalid_dep",
    details: string
  ) {
    super(`synthesizeTeamWorkflow ${reason}: ${details}`)
    this.name = "SynthesizeError"
  }
}

export function synthesizeTeamWorkflow(input: SynthesizeInput): SynthesizeResult {
  if (input.tasks.length === 0) {
    throw new SynthesizeError("empty", "task list is empty")
  }

  const taskIdSet = new Set(input.tasks.map((t) => t.id))

  // Validate dep references.
  for (const t of input.tasks) {
    for (const dep of t.dependencies) {
      if (!taskIdSet.has(dep)) {
        throw new SynthesizeError("invalid_dep", `task "${t.id}" depends on unknown task "${dep}"`)
      }
    }
  }

  // Cycle detection via Kahn's algorithm.
  const inDegree = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const t of input.tasks) {
    inDegree.set(t.id, t.dependencies.length)
    for (const dep of t.dependencies) {
      const arr = adj.get(dep) ?? []
      arr.push(t.id)
      adj.set(dep, arr)
    }
  }
  const queue: string[] = []
  for (const [id, d] of inDegree) {
    if (d === 0) queue.push(id)
  }
  let visited = 0
  while (queue.length > 0) {
    const id = queue.shift()!
    visited += 1
    for (const next of adj.get(id) ?? []) {
      const d = (inDegree.get(next) ?? 0) - 1
      inDegree.set(next, d)
      if (d === 0) queue.push(next)
    }
  }
  if (visited !== input.tasks.length) {
    throw new SynthesizeError(
      "cycle",
      `dependency cycle in tasks (visited ${visited} of ${input.tasks.length})`
    )
  }

  const nodes: WorkflowNode[] = input.tasks.map(
    (t) =>
      ({
        id: t.id,
        type: "action.team.task.dispatch",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: {
          label: t.title,
          params: {
            teamId: input.team.id,
            taskId: t.id,
            title: t.title,
            description: t.description,
            ...(t.expectedOutput ? { expectedOutput: t.expectedOutput } : {}),
            // Skill-aware assignment: the pool prefers this teammate when free,
            // falling back to round-robin (see teammate-pool ClaimOptions).
            ...(t.assignedTo ? { assignedTo: t.assignedTo } : {}),
          },
        },
      }) as WorkflowNode
  )

  const edges: WorkflowEdge[] = []
  for (const t of input.tasks) {
    for (const dep of t.dependencies) {
      edges.push({
        id: `${dep}->${t.id}`,
        source: dep,
        target: t.id,
      } as WorkflowEdge)
    }
  }

  const wallClock =
    input.wallClockTimeoutMs && input.wallClockTimeoutMs > 0
      ? input.wallClockTimeoutMs
      : 24 * 60 * 60_000 // 24h sentinel — the orchestrator skips wall-clock if 0, but the
  // settings schema requires min(1). We use a generous 24h so the wall-clock effectively
  // doesn't fire; team-level cancellation flows through the external AbortSignal.

  const now = Date.now()
  const workflowId = `__team__:${input.team.id}:${nanoid(8)}`

  const workflow: VisualWorkflow = {
    id: workflowId,
    schemaVersion: 1,
    name: input.team.name,
    description: input.team.description,
    nodes,
    edges,
    createdAt: now,
    updatedAt: now,
    settings: {
      errorPolicy: "stop",
      timeoutMs: wallClock,
      concurrency: 1,
      maxConcurrency: input.initialConcurrency,
      retryDefaults: DEFAULT_RETRY_POLICY,
    },
  }

  const nodeIdToTaskId = new Map<string, string>(input.tasks.map((t) => [t.id, t.id]))

  return { workflow, nodeIdToTaskId }
}
