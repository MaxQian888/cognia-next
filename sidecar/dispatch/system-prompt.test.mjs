import { test } from "node:test"
import assert from "node:assert/strict"
import { foldSystemPrompt, thinkingFromBudget } from "./system-prompt.mjs"

test("foldSystemPrompt: neither part → undefined", () => {
  assert.equal(foldSystemPrompt(undefined, undefined), undefined)
  assert.equal(foldSystemPrompt("", ""), undefined)
  assert.equal(foldSystemPrompt("   ", "\n\t "), undefined)
  assert.equal(foldSystemPrompt(123, null), undefined)
})

test("foldSystemPrompt: base-only Cognia instructions stay dynamic on resume", () => {
  assert.deepEqual(foldSystemPrompt("You are Cognia.", undefined), {
    type: "custom",
    prompt: "You are Cognia.",
    snapshot: false,
  })
  assert.deepEqual(foldSystemPrompt("  leading kept  ", ""), {
    type: "custom",
    prompt: "  leading kept  ",
    snapshot: false,
  })
  assert.deepEqual(foldSystemPrompt("Changed instructions", undefined), {
    type: "custom",
    prompt: "Changed instructions",
    snapshot: false,
  })
})

test("foldSystemPrompt: append-only instructions stay dynamic", () => {
  assert.deepEqual(foldSystemPrompt(undefined, "Brief mode on."), {
    type: "custom",
    prompt: "Brief mode on.",
    snapshot: false,
  })
  assert.deepEqual(foldSystemPrompt("", "Plan mode."), {
    type: "custom",
    prompt: "Plan mode.",
    snapshot: false,
  })
})

test("foldSystemPrompt: both → [base, append] in stable→dynamic order", () => {
  const out = foldSystemPrompt("BASE", "APPEND")
  assert.deepEqual(out, { type: "custom", prompt: ["BASE", "APPEND"], snapshot: false })
})

test("foldSystemPrompt: array preserves original (untrimmed) content of both parts", () => {
  const out = foldSystemPrompt("  base  ", "  append  ")
  assert.deepEqual(out, { type: "custom", prompt: ["  base  ", "  append  "], snapshot: false })
})

test("thinkingFromBudget: positive → enabled with budgetTokens", () => {
  assert.deepEqual(thinkingFromBudget(8000), { type: "enabled", budgetTokens: 8000 })
})

test("thinkingFromBudget: zero disables thinking, invalid or missing stays unspecified", () => {
  assert.deepEqual(thinkingFromBudget(0), { type: "disabled" })
  assert.equal(thinkingFromBudget(-1), undefined)
  assert.equal(thinkingFromBudget(undefined), undefined)
  assert.equal(thinkingFromBudget("8000"), undefined)
  assert.equal(thinkingFromBudget(null), undefined)
})

test("foldSystemPrompt preserves SDK custom and preset options while appending", () => {
  assert.deepEqual(foldSystemPrompt({ type: "custom", prompt: "" }), { type: "custom", prompt: "" })
  assert.deepEqual(foldSystemPrompt({ type: "preset", preset: "claude_code" }), {
    type: "preset",
    preset: "claude_code",
  })
  assert.deepEqual(foldSystemPrompt({ type: "preset", preset: "claude_code" }, "append"), {
    type: "preset",
    preset: "claude_code",
    append: "append",
  })
  assert.deepEqual(foldSystemPrompt(["one", "two"], "three"), {
    type: "custom",
    prompt: ["one", "two", "three"],
    snapshot: false,
  })
  assert.deepEqual(
    foldSystemPrompt(
      {
        type: "preset",
        preset: "claude_code",
        append: "one",
        snapshot: false,
        excludeDynamicSections: true,
      },
      "two"
    ),
    {
      type: "preset",
      preset: "claude_code",
      append: "one\n\ntwo",
      snapshot: false,
      excludeDynamicSections: true,
    }
  )
  assert.deepEqual(foldSystemPrompt({ type: "custom", prompt: ["one"], snapshot: false }, "two"), {
    type: "custom",
    prompt: ["one", "two"],
    snapshot: false,
  })
})

test("explicit SDK snapshot choices survive prompt composition", () => {
  for (const snapshot of [true, false]) {
    assert.deepEqual(foldSystemPrompt({ type: "custom", prompt: "base", snapshot }, "next"), {
      type: "custom",
      prompt: ["base", "next"],
      snapshot,
    })
    assert.deepEqual(
      foldSystemPrompt({ type: "preset", preset: "claude_code", snapshot }, "next"),
      { type: "preset", preset: "claude_code", append: "next", snapshot }
    )
  }
})
