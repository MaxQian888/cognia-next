import { test } from "node:test"
import assert from "node:assert/strict"

import { readabilityScore, checkReadability } from "./readability.mjs"

test("perfect transcription scores 1; empty pair scores 1", () => {
  assert.equal(readabilityScore("The auth module uses JWT.", "the auth module uses jwt"), 1)
  assert.equal(readabilityScore("", ""), 1)
  assert.equal(readabilityScore("", "surprise text"), 0, "content for nothing scores 0")
})

test("partial recall is proportional and ignores punctuation/case", () => {
  // 2 of 4 distinct words recovered.
  assert.equal(readabilityScore("alpha beta gamma delta", "ALPHA, gamma!"), 0.5)
})

test("garbage transcription scores near zero", () => {
  const score = readabilityScore(
    "refactor the authentication module to use refresh tokens",
    "zzz qqq vvv"
  )
  assert.ok(score < 0.2, `expected low score, got ${score}`)
})

test("multiset recall does not over-credit repeated words", () => {
  // original has 'a' three times; transcription supplies it once → 1/3.
  assert.equal(readabilityScore("a a a", "a"), 1 / 3)
})

test("checkReadability applies the threshold", () => {
  assert.deepEqual(checkReadability("one two three four five", "one two three four", 0.6), {
    score: 0.8,
    ok: true,
  })
  assert.equal(checkReadability("one two three four five", "one", 0.6).ok, false)
})
