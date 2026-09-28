import type { HookDecision } from "./types.ts"
import { test } from "node:test"
import assert from "node:assert/strict"
import { extractDecision, mergeOutcome, parseZeroExitOutput } from "../agent-hooks.ts"

test("extractDecision: permissionDecision deny (nested + top-level)", () => {
  assert.equal(
    extractDecision({ permissionDecision: "deny", decisionReason: "nope" }).block,
    "nope"
  )
  assert.equal(
    extractDecision({
      hookSpecificOutput: { permissionDecision: "block", permissionDecisionReason: "policy" },
    }).block,
    "policy"
  )
  assert.equal(
    extractDecision({ permissionDecision: "deny" }).block,
    "hook returned permissionDecision=deny"
  )
})

test("extractDecision: legacy decision=block", () => {
  assert.equal(extractDecision({ decision: "block", reason: "stop" }).block, "stop")
  assert.equal(extractDecision({ decision: "block" }).block, "hook returned decision=block")
})

test("extractDecision: ask / allow / additionalContext / mutations", () => {
  assert.equal(extractDecision({ permissionDecision: "ask" }).permissionDecision, "ask")
  assert.equal(extractDecision({ permissionDecision: "allow" }).permissionDecision, "allow")
  assert.equal(extractDecision({ additionalContext: "hi" }).additionalContext, "hi")
  assert.deepEqual(extractDecision({ updatedInput: { command: "ls" } }).updatedInput, {
    command: "ls",
  })
  assert.equal(extractDecision({ updatedToolOutput: "patched" }).updatedToolOutput, "patched")
  assert.equal(extractDecision({ updatedMCPToolOutput: "mcp" }).updatedToolOutput, "mcp")
})

test("parseZeroExitOutput: empty allow, JSON decision, plain text context", () => {
  assert.deepEqual(parseZeroExitOutput(""), {})
  assert.deepEqual(parseZeroExitOutput("   "), {})
  assert.equal(parseZeroExitOutput('{"additionalContext":"x"}').additionalContext, "x")
  assert.equal(parseZeroExitOutput("just text").additionalContext, "just text")
})

test("mergeOutcome: first block wins, contexts concatenated, mutations last-wins", () => {
  const dec: HookDecision = { warnings: [] }
  mergeOutcome(dec, { additionalContext: "a" })
  mergeOutcome(dec, { additionalContext: "b" })
  assert.equal(dec.additionalContext, "a\n\nb")
  mergeOutcome(dec, { block: "first" })
  mergeOutcome(dec, { block: "second" })
  assert.equal(dec.block, "first")
  mergeOutcome(dec, { updatedInput: { a: 1 } })
  mergeOutcome(dec, { updatedInput: { a: 2 } })
  assert.deepEqual(dec.updatedInput, { a: 2 })
  mergeOutcome(dec, { warning: "w1" })
  assert.deepEqual(dec.warnings, ["w1"])
})

test("mergeOutcome: ask escalates over allow", () => {
  const dec: HookDecision = { warnings: [] }
  mergeOutcome(dec, { permissionDecision: "allow" })
  assert.equal(dec.permissionDecision, "allow")
  mergeOutcome(dec, { permissionDecision: "ask" })
  assert.equal(dec.permissionDecision, "ask")
})
