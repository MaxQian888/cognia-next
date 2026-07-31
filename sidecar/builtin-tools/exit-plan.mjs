// exit_plan_mode — the cross-provider plan-ready signal tool.
//
// The Anthropic Agent SDK ships a native `ExitPlanMode` tool that the model
// calls in plan mode to present its final plan. Non-Anthropic providers (the
// ai-sdk dispatch path) have no such tool, so this is the equivalent: a
// lightweight signal the model calls with `{ plan }` when its plan is ready
// for the user's approval. It performs no work — the renderer/CLI reads the
// tool *input* (the plan body) to open its plan-approval overlay; the result
// is irrelevant. The plan-mode gate (ai-sdk-tools.mjs) whitelists this tool so
// it can run while every mutating tool is blocked, and the CLI suppresses its
// generic approval prompt so only the plan overlay decides.

import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { toolText } from "./safety.mjs"

/** Bare tool name (namespaced as `mcp__cognia-tools__exit_plan_mode`). */
export const EXIT_PLAN_TOOL_NAME = "exit_plan_mode"

const exitPlanShape = {
  plan: z
    .string()
    .min(1)
    .describe(
      "The final implementation plan, as markdown. Call this ONLY when the plan is complete and ready for approval — never to ask a clarifying question."
    ),
}

async function execExitPlan(args) {
  // No side effects: the surface (CLI plan overlay) consumes the tool input.
  // Acknowledge so the model's turn completes cleanly.
  return toolText({ submitted: true, length: String(args?.plan ?? "").length })
}

/** Build the exit_plan_mode tool definition. */
export function createExitPlanTool() {
  return tool(
    EXIT_PLAN_TOOL_NAME,
    "Submit your final plan for the user's approval (plan mode). Provide the full plan as markdown in `plan`. Do not call this to ask questions — only when the plan is ready to implement.",
    exitPlanShape,
    execExitPlan,
    { alwaysLoad: true }
  )
}
