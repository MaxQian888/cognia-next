/**
 * Translate an `AgentPlan` + its steps into a runnable `VisualWorkflow` whose
 * nodes are `action.plan.step.dispatch` instances and whose edges encode the
 * `step.dependencies` DAG. The synthesized workflow is fed to `runWorkflow`.
 * (ADR-0045 P2)
 *
 * Mirrors `lib/ai/agent/team/synthesize-workflow.ts`: the synthesizer is pure
 * (no Dexie / no executeAgent / no abort signal) — it only shapes types.
 * Validates non-empty input, dependency-id references, and absence of cycles
 * (Kahn's algorithm).
 *
 * Synthesized workflow id has the `__plan__:<planId>:<nonce>` prefix; the UI
 * must not attempt to load a workflow definition for this id. The full
 * snapshot lives on the `workflowRuns` row.
 */

import { nanoid } from "nanoid"
import type { AgentPlan, PlanStep } from "@/types/agent/plan"
import { DEFAULT_RETRY_POLICY } from "@/types/workflow/visual"
import type { VisualWorkflow, WorkflowEdge, WorkflowNode } from "@/types/workflow/visual"

export interface SynthesizePlanResult {
  workflow: VisualWorkflow
  nodeIdToStepId: Map<string, string>
}

export class PlanSynthesizeError extends Error {
  constructor(
    public readonly reason: "cycle" | "empty" | "invalid_dep",
    details: string
  ) {
    super(`synthesizePlanWorkflow ${reason}: ${details}`)
    this.name = "PlanSynthesizeError"
  }
}

/**
 * Pure plan → workflow compiler. Each step becomes one
 * `action.plan.step.dispatch` node; each dependency becomes one edge.
 */
export function synthesizePlanWorkflow(plan: AgentPlan): SynthesizePlanResult {
  const steps = plan.steps
  if (steps.length === 0) {
    throw new PlanSynthesizeError("empty", "plan has no steps")
  }

  const stepIds = new Set(steps.map((s) => s.id))

  // Validate dependency references.
  for (const s of steps) {
    for (const dep of s.dependencies) {
      if (!stepIds.has(dep)) {
        throw new PlanSynthesizeError(
          "invalid_dep",
          `step "${s.id}" depends on unknown step "${dep}"`
        )
      }
    }
  }

  // Cycle detection via Kahn's algorithm.
  const inDegree = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const s of steps) {
    inDegree.set(s.id, s.dependencies.length)
    for (const dep of s.dependencies) {
      const arr = adj.get(dep) ?? []
      arr.push(s.id)
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
  if (visited !== steps.length) {
    throw new PlanSynthesizeError(
      "cycle",
      `dependency cycle in steps (visited ${visited} of ${steps.length})`
    )
  }

  const nodes: WorkflowNode[] = steps.map(
    (s: PlanStep) =>
      ({
        id: s.id,
        type: "action.plan.step.dispatch",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: {
          label: s.title,
          params: {
            planId: plan.id,
            stepId: s.id,
            title: s.title,
            stepKind: s.kind,
          },
        },
      }) as WorkflowNode
  )

  const edges: WorkflowEdge[] = []
  for (const s of steps) {
    for (const dep of s.dependencies) {
      edges.push({ id: `${dep}->${s.id}`, source: dep, target: s.id } as WorkflowEdge)
    }
  }

  const now = Date.now()
  const workflowId = `__plan__:${plan.id}:${nanoid(8)}`
  const maxConcurrency =
    plan.config.maxConcurrency && plan.config.maxConcurrency > 0 ? plan.config.maxConcurrency : 1

  const workflow: VisualWorkflow = {
    id: workflowId,
    schemaVersion: 1,
    name: plan.title,
    description: plan.description ?? "",
    nodes,
    edges,
    createdAt: now,
    updatedAt: now,
    settings: {
      errorPolicy: plan.config.errorPolicy ?? "stop",
      // 24h sentinel — plan-level cancellation flows through the external
      // AbortSignal, not the wall-clock timeout (mirrors the team synthesizer).
      timeoutMs: 24 * 60 * 60_000,
      concurrency: 1,
      maxConcurrency,
      retryDefaults: DEFAULT_RETRY_POLICY,
    },
  }

  const nodeIdToStepId = new Map<string, string>(steps.map((s) => [s.id, s.id]))
  return { workflow, nodeIdToStepId }
}
