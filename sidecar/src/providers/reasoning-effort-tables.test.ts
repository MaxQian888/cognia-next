import { test } from "node:test"
import assert from "node:assert/strict"

import {
  EFFORT_TO_BUDGET,
  GENERIC_REASONING_EFFORT,
  OPENAI_EFFORT_VALUES,
  openAiEffortValuesForModel,
  claude55CapabilitiesForModel,
  compatibleEffortValuesForModel,
  normalizeCompatibleEffort,
  geminiThinkingLevelsForModel,
} from "./reasoning-effort-tables.ts"

test("current native-compatible effort ladders match vendor contracts and preserve unknown models", () => {
  for (const [model, values] of [
    ["grok-4.7-20260916", ["low", "medium", "high", "xhigh"]],
    ["qwen3.8-max-0902", ["low", "medium", "xhigh"]],
    ["glm-5.3", ["low", "high", "max"]],
    ["moonshotai/kimi-k3", ["low", "high", "max"]],
    ["MiniMax-M3", []],
    ["kimi-k2.7-code", []],
  ] as const) {
    assert.deepEqual(compatibleEffortValuesForModel(model), values)
  }
  assert.equal(compatibleEffortValuesForModel("MiniMax-M3.1-Flash"), undefined)
  assert.equal(compatibleEffortValuesForModel("grok-3"), undefined)
  assert.equal(compatibleEffortValuesForModel(), undefined)
  assert.deepEqual(geminiThinkingLevelsForModel("gemini-4-argon"), ["low", "medium", "high"])
  assert.equal(geminiThinkingLevelsForModel("gemini-2.5-pro"), undefined)
})

test("saved unsupported effort normalizes to a supported tier without changing the request", () => {
  for (const [model, requested, expected] of [
    ["grok-4.7", "max", "xhigh"],
    ["grok-4.7", "minimal", "low"],
    ["qwen3.8-max", "high", "xhigh"],
    ["qwen3.8-max", "max", "xhigh"],
    ["glm-5.3", "medium", "high"],
    ["glm-5.3", "xhigh", "max"],
    ["kimi-k3", "none", "low"],
    ["kimi-k3", "max", "max"],
    ["MiniMax-M3", "max", undefined],
    ["kimi-k2.7", "high", undefined],
  ]) {
    assert.equal(normalizeCompatibleEffort(model, requested!), expected)
  }
})

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

test("Claude 5.5 capabilities cover all current model spellings without changing older models", () => {
  for (const model of ["claude-sonnet-5-5", "claude-opus-5-5", "anthropic/claude-haiku-5.5"]) {
    assert.deepEqual(claude55CapabilitiesForModel(model), {
      supportsSampling: false,
      effortValues: ["low", "medium", "high", "xhigh", "max"],
    })
  }
  assert.equal(claude55CapabilitiesForModel("claude-haiku-4-5"), undefined)
  assert.equal(claude55CapabilitiesForModel("claude-sonnet-5"), undefined)
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

test("GPT-6 accepted effort values preserve max and reject unsupported minimal", () => {
  for (const model of ["gpt-6.1-sol", "gpt-6-astra", "openai/gpt-6.1-sol-20260929"]) {
    assert.deepEqual(
      [...openAiEffortValuesForModel(model)],
      ["low", "medium", "high", "xhigh", "max"]
    )
  }
  assert.deepEqual(
    [...openAiEffortValuesForModel("gpt-6-luna")],
    ["none", "low", "medium", "high", "xhigh", "max"]
  )
  assert.equal(openAiEffortValuesForModel("gpt-5.6"), OPENAI_EFFORT_VALUES)
  assert.equal(openAiEffortValuesForModel(), OPENAI_EFFORT_VALUES)
})
