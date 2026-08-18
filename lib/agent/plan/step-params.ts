/**
 * Validation for a plan step's kind-specific `params` (ADR-0045).
 *
 * Two producers hand the plan runtime free-form params — the composer dialog
 * (string fields typed by a human) and the `create_plan` / `update_plan` agent
 * tools (a JSON object emitted by the model). Both need the SAME answer to
 * "does this params object actually let the executor run this step?", so the
 * required-field rules live here rather than in either caller.
 *
 * The rules mirror `lib/agent/plan/step-dispatch.ts:runStepWork` exactly: a
 * params object that passes here is one the dispatcher will not reject with a
 * non-retryable "requires …" error.
 *
 * Pure — no Dexie, no React — so it is shared by a client component, a
 * renderer capture module, and its own unit test.
 */

import type { PlanStepKind, PlanStepParams } from "@/types/agent/plan"

/** Why a params object cannot be used. */
export type PlanStepParamsError = "missing"

/** A validated result: either usable params (possibly `undefined`) or an error. */
export type PlanStepParamsResult = { params?: PlanStepParams } | { error: PlanStepParamsError }

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Validate an already-parsed params object against its step kind.
 *
 * `raw` is whatever the producer collected (a `Record<string, unknown>`);
 * unknown keys are dropped rather than persisted, so a hallucinated field
 * can't ride into Dexie. Optional-params kinds (`agent_turn`, `approval_gate`)
 * return `{ params: undefined }` when nothing meaningful was supplied, which
 * is the shape the step model uses for "derive the prompt from the title".
 */
export function validatePlanStepParams(kind: PlanStepKind, raw: unknown): PlanStepParamsResult {
  const p = record(raw)
  switch (kind) {
    case "agent_turn": {
      const prompt = str(p.prompt)
      return prompt ? { params: { kind: "agent_turn", prompt } } : { params: undefined }
    }
    case "approval_gate": {
      const prompt = str(p.prompt)
      return prompt ? { params: { kind: "approval_gate", prompt } } : { params: undefined }
    }
    case "teammate_dispatch": {
      // The dispatcher requires a team; the teammate is optional (the run's
      // teammate pool picks one when it is absent).
      const teamId = str(p.teamId)
      if (!teamId) return { error: "missing" }
      const teammateId = str(p.teammateId)
      const spawnPrompt = str(p.spawnPrompt)
      return {
        params: {
          kind: "teammate_dispatch",
          teamId,
          ...(teammateId ? { teammateId } : {}),
          ...(spawnPrompt ? { spawnPrompt } : {}),
        },
      }
    }
    case "sub_workflow": {
      const workflowId = str(p.workflowId)
      if (!workflowId) return { error: "missing" }
      return { params: { kind: "sub_workflow", workflowId } }
    }
    case "tool_call": {
      const toolName = str(p.toolName)
      if (!toolName) return { error: "missing" }
      return { params: { kind: "tool_call", toolName, input: record(p.input) } }
    }
    case "mcp_tool_call": {
      const serverId = str(p.serverId)
      const toolName = str(p.toolName)
      if (!serverId || !toolName) return { error: "missing" }
      return { params: { kind: "mcp_tool_call", serverId, toolName, input: record(p.input) } }
    }
  }
}
