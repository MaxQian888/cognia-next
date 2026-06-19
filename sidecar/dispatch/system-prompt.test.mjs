import { test } from "node:test"
import assert from "node:assert/strict"
import { foldSystemPrompt, thinkingFromBudget } from "./system-prompt.mjs"

test("foldSystemPrompt: neither part → undefined", () => {
  assert.equal(foldSystemPrompt(undefined, undefined), undefined)
  assert.equal(foldSystemPrompt("", ""), undefined)
  assert.equal(foldSystemPrompt("   ", "\n\t "), undefined)
  assert.equal(foldSystemPrompt(123, null), undefined)
})

test("foldSystemPrompt: only base → that string (untrimmed content preserved)", () => {
  assert.equal(foldSystemPrompt("You are Cognia.", undefined), "You are Cognia.")
  assert.equal(foldSystemPrompt("  leading kept  ", ""), "  leading kept  ")
})

test("foldSystemPrompt: only append → that string", () => {
  assert.equal(foldSystemPrompt(undefined, "Brief mode on."), "Brief mode on.")
  assert.equal(foldSystemPrompt("", "Plan mode."), "Plan mode.")
})

test("foldSystemPrompt: both → [base, append] in stable→dynamic order", () => {
  const out = foldSystemPrompt("BASE", "APPEND")
  assert.deepEqual(out, ["BASE", "APPEND"])
})

test("foldSystemPrompt: array preserves original (untrimmed) content of both parts", () => {
  const out = foldSystemPrompt("  base  ", "  append  ")
  assert.deepEqual(out, ["  base  ", "  append  "])
})

test("thinkingFromBudget: positive → enabled with budgetTokens", () => {
  assert.deepEqual(thinkingFromBudget(8000), { type: "enabled", budgetTokens: 8000 })
})

test("thinkingFromBudget: 0 / negative / missing / non-number → undefined", () => {
  assert.equal(thinkingFromBudget(0), undefined)
  assert.equal(thinkingFromBudget(-1), undefined)
  assert.equal(thinkingFromBudget(undefined), undefined)
  assert.equal(thinkingFromBudget("8000"), undefined)
  assert.equal(thinkingFromBudget(null), undefined)
})
