/**
 * Plan ⇄ VisualWorkflow conversions (ADR-0045 §2 / ADR-0011).
 *
 * `synthesize-workflow.ts` already compiles a plan into an EPHEMERAL workflow
 * for one run (`__plan__:<planId>:<nonce>`, never persisted, deliberately
 * unopenable in the editor). These two functions are the durable, user-facing
 * direction:
 *
 *   • `planWorkflowDraft`  — plan → a real, editable workflow row. The same
 *     compiler produces the nodes/edges, then a `trigger.manual` root and a
 *     grid layout are added, because a workflow a human will open needs an
 *     entry point and non-overlapping positions (the synthesizer stacks every
 *     node at 0,0 — fine for a headless run, unusable in the canvas).
 *
 *   • `planInputFromWorkflow` — workflow → plan. Deliberately ONE
 *     `sub_workflow` step (optionally behind an approval gate) rather than one
 *     step per node: plan step kinds and workflow node kinds are different
 *     vocabularies, and the thing that knows how to run nodes IS the
 *     orchestrator. Projecting node-by-node would either lose node semantics
 *     or duplicate the orchestrator inside the plan runtime.
 *
 * Both are pure — no Dexie — so the slash command owns persistence and these
 * stay unit-testable.
 */

import type { VisualWorkflow, WorkflowEdge, WorkflowNode } from "@/types/workflow/visual"
import type { AgentPlan, CreatePlanInput } from "@/types/agent/plan"
import { synthesizePlanWorkflow } from "./synthesize-workflow"

/** Horizontal / vertical spacing of the generated grid layout, in canvas units. */
const COLUMN_WIDTH = 320
const ROW_HEIGHT = 140

/** The fields `createWorkflow` accepts for a fresh row. */
export interface PlanWorkflowDraft {
  name: string
  description?: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  tags: string[]
  settings: VisualWorkflow["settings"]
}

/**
 * Compile a plan into a persistable workflow draft.
 *
 * Layout: steps are laid out in dependency "levels" (longest path from a root),
 * one column per level, so the canvas reads left-to-right the way the plan
 * executes. The manual trigger sits in its own leading column and feeds every
 * root step.
 *
 * Throws `PlanSynthesizeError` for an empty plan, an unknown dependency, or a
 * cycle — the same validation the run path performs, so an export can never
 * produce a workflow the orchestrator would refuse.
 */
export function planWorkflowDraft(plan: AgentPlan): PlanWorkflowDraft {
  const { workflow } = synthesizePlanWorkflow(plan)

  const stepById = new Map(plan.steps.map((s) => [s.id, s]))
  const level = new Map<string, number>()
  const levelOf = (id: string, seen: Set<string> = new Set()): number => {
    const cached = level.get(id)
    if (cached !== undefined) return cached
    // `synthesizePlanWorkflow` already rejected cycles; the guard keeps this
    // helper safe if it is ever called on unvalidated input.
    if (seen.has(id)) return 0
    seen.add(id)
    const deps = stepById.get(id)?.dependencies ?? []
    const value = deps.length === 0 ? 0 : Math.max(...deps.map((d) => levelOf(d, seen) + 1))
    level.set(id, value)
    return value
  }

  const rowCursor = new Map<number, number>()
  const nodes: WorkflowNode[] = workflow.nodes.map((node) => {
    const col = levelOf(node.id)
    const row = rowCursor.get(col) ?? 0
    rowCursor.set(col, row + 1)
    return {
      ...node,
      position: { x: (col + 1) * COLUMN_WIDTH, y: row * ROW_HEIGHT },
    }
  })

  const triggerId = `${plan.id}-trigger`
  const trigger = {
    id: triggerId,
    type: "trigger.manual",
    typeVersion: 1,
    position: { x: 0, y: 0 },
    data: { label: plan.title, params: {} },
  } as WorkflowNode

  const rootIds = plan.steps.filter((s) => s.dependencies.length === 0).map((s) => s.id)
  const edges: WorkflowEdge[] = [
    ...rootIds.map(
      (target) => ({ id: `${triggerId}->${target}`, source: triggerId, target }) as WorkflowEdge
    ),
    ...workflow.edges,
  ]

  return {
    name: plan.title,
    ...(plan.description ? { description: plan.description } : {}),
    nodes: [trigger, ...nodes],
    edges,
    // Tagged so an exported plan is findable in the library, and so a future
    // sweep can tell generated rows from hand-authored ones.
    tags: ["plan"],
    settings: workflow.settings,
  }
}

/** Minimal workflow shape `planInputFromWorkflow` reads. */
export type WorkflowSummary = Pick<VisualWorkflow, "id" | "name" | "description">

/**
 * Project a saved workflow into a plan that runs it as a `sub_workflow` step.
 *
 * `withApprovalGate` prepends an `approval_gate` step — the reason to wrap a
 * workflow in a plan at all is usually "let me review before this fires", and
 * the gate is answerable from the app-root `GateModalsHost`.
 */
export function planInputFromWorkflow(
  workflow: WorkflowSummary,
  opts: { sessionId: string; characterId?: string; withApprovalGate?: boolean }
): CreatePlanInput {
  const runStep = {
    title: workflow.name,
    kind: "sub_workflow" as const,
    params: { kind: "sub_workflow" as const, workflowId: workflow.id },
    ...(workflow.description ? { description: workflow.description } : {}),
  }
  const steps = opts.withApprovalGate
    ? [
        {
          title: `Approve running "${workflow.name}"`,
          kind: "approval_gate" as const,
          params: { kind: "approval_gate" as const },
        },
        { ...runStep, dependsOn: [0] },
      ]
    : [runStep]

  return {
    sessionId: opts.sessionId,
    ...(opts.characterId ? { characterId: opts.characterId } : {}),
    title: workflow.name.slice(0, 120),
    ...(workflow.description ? { description: workflow.description } : {}),
    source: "manual",
    // A sub_workflow step never resolves to the in-session driver, but pin the
    // mode explicitly so the intent survives a future strategy change.
    executionMode: "orchestrated",
    steps,
    metadata: { workflowId: workflow.id },
  }
}
