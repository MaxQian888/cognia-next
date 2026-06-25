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
import type { AgentTeam, AgentTeamConfig, AgentTeamTask } from "@/types/agent/agent-team"
import { DEFAULT_RETRY_POLICY } from "@/types/workflow/visual"
import type {
  VisualWorkflow,
  WorkflowEdge,
  WorkflowNode,
  WorkflowRetryPolicy,
} from "@/types/workflow/visual"

/**
 * Derive the per-node retry policy from a team's config. The orchestrator
 * honors `settings.retryDefaults` for `retryable` nodes (the team dispatch node
 * is retryable), so this is the single point that makes the UI-editable
 * `maxRetries` / `enableTaskRetry` knobs actually affect a run.
 *
 * - `enableTaskRetry === false` → one attempt, no retry (overrides maxRetries).
 * - otherwise `attempts = (maxRetries ?? 2) + 1` — i.e. initial try + retries.
 *   The `?? 2` default preserves the prior hardcoded behavior (attempts: 3).
 *
 * Backoff shape (mode / baseMs / maxMs) is inherited from DEFAULT_RETRY_POLICY.
 */
export function resolveRetryPolicy(config: AgentTeamConfig | undefined): WorkflowRetryPolicy {
  const retries = config?.enableTaskRetry === false ? 0 : (config?.maxRetries ?? 2)
  return { ...DEFAULT_RETRY_POLICY, attempts: retries + 1 }
}

export interface SynthesizeInput {
  team: AgentTeam
  tasks: AgentTeamTask[]
  initialConcurrency: number
  wallClockTimeoutMs?: number
  /** Forwarded into node executor via TeamRunContext; not encoded into VW. */
  perTaskTimeoutMs?: number
  /**
   * Dependency task ids that are satisfied OUTSIDE this workflow (executed in a
   * prior wave, or cancelled). Used by adaptive re-planning's wave runner: a
   * wave is a subset of the full task DAG, so its tasks may depend on tasks not
   * present here. Such deps skip reference-validation, edge creation, and
   * in-degree counting, but are KEPT in node params so the dispatch executor
   * still reads their blackboard results via `readDependencyResults`. Defaults
   * to empty → the single-pass synthesis behaves exactly as before.
   */
  satisfiedDependencyIds?: ReadonlySet<string>
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
  const satisfied = input.satisfiedDependencyIds ?? new Set<string>()
  // Intra-workflow deps drive validation / edges / scheduling; deps satisfied
  // outside this workflow are skipped (kept in params only).
  const isIntra = (dep: string): boolean => taskIdSet.has(dep)

  // Validate dep references. A dep is valid if it is in this workflow OR was
  // declared satisfied outside it (prior wave / cancelled).
  for (const t of input.tasks) {
    for (const dep of t.dependencies) {
      if (!taskIdSet.has(dep) && !satisfied.has(dep)) {
        throw new SynthesizeError("invalid_dep", `task "${t.id}" depends on unknown task "${dep}"`)
      }
    }
  }

  // Cycle detection via Kahn's algorithm — only over intra-workflow edges.
  const inDegree = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const t of input.tasks) {
    const intraDeps = t.dependencies.filter(isIntra)
    inDegree.set(t.id, intraDeps.length)
    for (const dep of intraDeps) {
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
            // Upstream task ids — the executor reads their blackboard results
            // and injects them into the teammate prompt so the team builds on
            // prior work (deps are also encoded as edges for scheduling).
            ...(t.dependencies.length > 0 ? { dependencies: t.dependencies } : {}),
          },
        },
      }) as WorkflowNode
  )

  const edges: WorkflowEdge[] = []
  for (const t of input.tasks) {
    for (const dep of t.dependencies) {
      // Only intra-workflow deps become scheduling edges; external (satisfied)
      // deps stay as params-only blackboard reads.
      if (!isIntra(dep)) continue
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
      retryDefaults: resolveRetryPolicy(input.team.config),
    },
  }

  const nodeIdToTaskId = new Map<string, string>(input.tasks.map((t) => [t.id, t.id]))

  return { workflow, nodeIdToTaskId }
}
