// Contract checks for the ADR-0045 plan-authoring tools. The tools do no work
// in the sidecar (the renderer owns the plan row), so what matters here is that
// the statuses they describe stay in step with `types/agent/plan.ts` and that
// the model is told a rejected plan is closed.

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

import {
  PLAN_STATUSES,
  PLAN_STEP_STATUSES,
  TERMINAL_PLAN_STATUSES,
  createPlanTools,
} from "./plan-tools.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const planTypes = readFileSync(path.join(here, "../../types/agent/plan.ts"), "utf8")

/** String literals of one `export type X = | "a" | "b"` union in plan.ts. */
function unionMembers(typeName) {
  const match = planTypes.match(new RegExp(`export type ${typeName} =([^;]*?)\\n\\n`, "s"))
  assert.ok(match, `${typeName} not found in types/agent/plan.ts`)
  return [...match[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1])
}

test("PLAN_STATUSES mirrors the PlanStatus union, rejected included", () => {
  assert.deepEqual([...PLAN_STATUSES].sort(), unionMembers("PlanStatus").sort())
  assert.ok(PLAN_STATUSES.includes("rejected"))
})

test("PLAN_STEP_STATUSES mirrors the PlanStepStatus union", () => {
  assert.deepEqual([...PLAN_STEP_STATUSES].sort(), unionMembers("PlanStepStatus").sort())
})

test("terminal statuses are a subset and include rejected", () => {
  for (const status of TERMINAL_PLAN_STATUSES) assert.ok(PLAN_STATUSES.includes(status))
  assert.deepEqual([...TERMINAL_PLAN_STATUSES].sort(), [
    "cancelled",
    "completed",
    "failed",
    "rejected",
  ])
})

test("the tool descriptions tell the model a rejected plan is closed", () => {
  const [create, update] = createPlanTools()
  assert.match(create.description, /reject/i)
  assert.match(create.description, /create a new plan/i)
  assert.match(update.description, /rejected or cancelled/i)
})
