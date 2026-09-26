import { test } from "node:test"
import assert from "node:assert/strict"

import {
  EFFORT_TO_BUDGET,
  GENERIC_REASONING_EFFORT,
  OPENAI_EFFORT_VALUES,
} from "./reasoning-effort-tables.ts"

test("every budget tier has a positive, increasing token budget", () => {
  const tiers = ["low", "medium", "high", "xhigh", "max"] as const
  const budgets = tiers.map((tier) => EFFORT_TO_BUDGET[tier])
  assert.ok(budgets.every((budget) => Number.isInteger(budget) && budget > 0))
  assert.deepEqual(
    budgets,
    [...budgets].sort((a, b) => a - b),
    "a deeper tier never thinks less"
  )
})

test("OpenAI's accepted values exclude the app-only `max` tier", () => {
  assert.equal(OPENAI_EFFORT_VALUES.has("max"), false)
  for (const value of ["none", "minimal", "low", "medium", "high", "xhigh"]) {
    assert.equal(OPENAI_EFFORT_VALUES.has(value), true, value)
  }
})

test("the generic openai-compatible map folds every app tier onto low|medium|high", () => {
  assert.deepEqual(
    new Set(Object.values(GENERIC_REASONING_EFFORT)),
    new Set(["low", "medium", "high"])
  )
  assert.equal(GENERIC_REASONING_EFFORT.minimal, "low")
  assert.equal(GENERIC_REASONING_EFFORT.max, "high")
})

test("the tables are frozen: neither consumer can drift them at runtime", () => {
  assert.equal(Object.isFrozen(EFFORT_TO_BUDGET), true)
  assert.equal(Object.isFrozen(GENERIC_REASONING_EFFORT), true)
  assert.equal(Object.isFrozen(OPENAI_EFFORT_VALUES), true)
})
