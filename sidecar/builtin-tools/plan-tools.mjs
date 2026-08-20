// create_plan / update_plan — the agent-authored half of the Unified Plan
// Execution Hub (ADR-0045 §3.2, `PlanSource: "agent_tool"`).
//
// `exit_plan_mode` is the *plan mode* signal: one shot, at the end of a
// research turn, gated behind an approval. These two are the opposite — they
// let the agent structure a multi-step job and then keep it honest as it works
// (mark step 2 in progress, step 1 done, add a step it discovered). Together
// they cover both ways a plan comes into existence.
//
// Like `exit_plan_mode`, the tools do NO work in the sidecar: the renderer
// watches the tool_use blocks in the SDK event stream
// (`lib/agent/plan/agent-tool-capture.ts`) and performs the Dexie write
// through the plan runtime, so the one-open-plan-per-session invariant, the
// event log, and the approval dock all behave exactly as they do for every
// other producer. The result here is a plain acknowledgement so the turn
// completes cleanly.
//
// Kept dependency-light (only zod + the SDK's `tool`) and free of `lib/`
// imports — the sidecar cannot import renderer code.

import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { toolText } from "./safety.mjs"

/** Bare tool names (namespaced as `mcp__cognia-tools__<name>`). */
export const CREATE_PLAN_TOOL_NAME = "create_plan"
export const UPDATE_PLAN_TOOL_NAME = "update_plan"

/** Step kinds the plan executor implements (`lib/agent/plan/step-dispatch.ts`). */
export const PLAN_STEP_KINDS = [
  "agent_turn",
  "teammate_dispatch",
  "tool_call",
  "mcp_tool_call",
  "sub_workflow",
  "approval_gate",
  "editor_review",
]

/** Step statuses the agent may report (terminal + live). */
export const PLAN_STEP_STATUSES = [
  "pending",
  "ready",
  "in_progress",
  "completed",
  "failed",
  "skipped",
  "blocked",
]

export const PLAN_EXECUTION_MODES = ["in_session", "orchestrated", "auto"]

const stepShape = z.object({
  title: z.string().min(1).describe("One short imperative sentence naming the step."),
  description: z.string().optional().describe("Optional detail for this step."),
  kind: z
    .enum(PLAN_STEP_KINDS)
    .optional()
    .describe("Execution kind. Defaults to `agent_turn` (a normal turn you take yourself)."),
  dependsOn: z
    .array(z.number().int().min(0))
    .optional()
    .describe(
      "Zero-based indices of steps in THIS list that must finish first. Omit for a simple sequence — steps then run top to bottom."
    ),
})

const createPlanShape = {
  title: z.string().min(1).describe("Short name for the whole plan."),
  description: z.string().optional().describe("Optional one-paragraph summary of the plan."),
  steps: z.array(stepShape).min(1).describe("The ordered steps, 2-16 for most work."),
  executionMode: z
    .enum(PLAN_EXECUTION_MODES)
    .optional()
    .describe(
      "`auto` (default) lets the runtime choose: a simple chain of your own turns runs in this conversation, anything with delegation or parallelism runs on the orchestrator."
    ),
}

const stepUpdateShape = z.object({
  step: z
    .union([z.number().int().min(0), z.string()])
    .describe("Zero-based step index, or the step's id."),
  status: z.enum(PLAN_STEP_STATUSES).describe("The step's new status."),
  result: z.string().optional().describe("Short summary of what the step produced."),
})

const updatePlanShape = {
  planId: z
    .string()
    .optional()
    .describe("Plan to update. Omit to update this session's open plan (the usual case)."),
  title: z.string().optional().describe("Rename the plan."),
  description: z.string().optional().describe("Replace the plan summary."),
  steps: z
    .array(stepShape)
    .optional()
    .describe(
      "Replace the whole step list. Only allowed while the plan is still a draft / awaiting approval — a running plan's steps are owned by the executor."
    ),
  stepUpdates: z
    .array(stepUpdateShape)
    .optional()
    .describe("Report progress on individual steps without rewriting the list."),
}

async function execCreatePlan(args) {
  // No side effects here — the renderer's capture owns the write.
  return toolText({
    created: true,
    title: String(args?.title ?? ""),
    steps: Array.isArray(args?.steps) ? args.steps.length : 0,
  })
}

async function execUpdatePlan(args) {
  return toolText({
    updated: true,
    ...(Array.isArray(args?.steps) ? { steps: args.steps.length } : {}),
    ...(Array.isArray(args?.stepUpdates) ? { stepUpdates: args.stepUpdates.length } : {}),
  })
}

/** Build the two plan-authoring tool definitions. */
export function createPlanTools() {
  return [
    tool(
      CREATE_PLAN_TOOL_NAME,
      "Create a structured, trackable plan for a multi-step job. The user sees it as a live checklist and can approve, edit, or run it. Use this when the work has several distinct steps worth tracking — not for a single action, and not to ask a question.",
      createPlanShape,
      execCreatePlan,
      { alwaysLoad: true }
    ),
    tool(
      UPDATE_PLAN_TOOL_NAME,
      "Update the plan you created: rename it, replace its steps while it is still a draft, or report progress (`stepUpdates`) as you finish each step. Keep it current — the user is watching this checklist.",
      updatePlanShape,
      execUpdatePlan,
      { alwaysLoad: true }
    ),
  ]
}
