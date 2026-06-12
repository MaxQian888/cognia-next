// Tests for the cross-provider exit_plan_mode signal tool.

import { test } from "node:test"
import assert from "node:assert/strict"

import { createExitPlanTool, EXIT_PLAN_TOOL_NAME } from "./exit-plan.mjs"
import { collectCogniaToolDefs } from "./index.mjs"

test("createExitPlanTool exposes the exit_plan_mode name and accepts a plan", async () => {
  const t = createExitPlanTool()
  assert.equal(t.name, EXIT_PLAN_TOOL_NAME)
  const result = await t.handler({ plan: "# Plan\n- a\n- b" }, {})
  // Side-effect-free acknowledgement; the surface reads the tool INPUT.
  const text = result.content.map((c) => c.text).join("")
  assert.match(text, /submitted/)
})

test("collectCogniaToolDefs registers exit_plan_mode on the ai-sdk path only", () => {
  const aiSdk = collectCogniaToolDefs({ enabled: { git: true }, dispatchPath: "ai-sdk" })
  assert.ok(
    aiSdk.some((d) => d.name === EXIT_PLAN_TOOL_NAME),
    "exit_plan_mode present on the ai-sdk path"
  )

  const anthropic = collectCogniaToolDefs({ enabled: { git: true }, dispatchPath: "anthropic" })
  assert.ok(
    !anthropic.some((d) => d.name === EXIT_PLAN_TOOL_NAME),
    "exit_plan_mode absent on the Anthropic path (native ExitPlanMode used instead)"
  )
})
