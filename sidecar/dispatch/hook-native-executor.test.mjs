import assert from "node:assert/strict"
import test from "node:test"

import { createHookBudgetGovernor, createNativeHookExecutor } from "./hook-native-executor.mjs"

function fakeQuery(events, capture) {
  return (input) => {
    capture.push(input)
    return {
      async *[Symbol.asyncIterator]() {
        yield* events
      },
      async interrupt() {},
    }
  }
}

test("native hook executor installs only its PII boundary and constrains prompt handlers", async () => {
  const calls = []
  const execute = createNativeHookExecutor({
    queryFn: fakeQuery(
      [
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: '{"additionalContext":"approved"}',
          total_cost_usd: 0.02,
        },
      ],
      calls
    ),
    maxBudgetUsd: 1,
    allowedTools: ["Read"],
  })

  const outcome = await execute({ type: "prompt", prompt: "review" }, '{"secret":"x"}', {
    depth: 0,
  })
  assert.deepEqual(outcome, { output: '{"additionalContext":"approved"}' })
  assert.deepEqual(calls[0].options.settingSources, [])
  assert.deepEqual(Object.keys(calls[0].options.hooks), ["PostToolUse", "PostToolUseFailure"])
  assert.deepEqual(calls[0].options.allowedTools, [])
  assert.equal(calls[0].options.maxTurns, 1)
  assert.match(calls[0].prompt, /hook-origin depth="1"/)
})

test("native hook executor redacts handler configuration before the nested model call", async () => {
  const calls = []
  const execute = createNativeHookExecutor({
    queryFn: fakeQuery(
      [{ type: "result", subtype: "success", is_error: false, result: "{}" }],
      calls
    ),
  })

  await execute({ type: "prompt", prompt: "Contact alice@example.com" }, "{}", { depth: 0 })
  await execute(
    {
      type: "mcp_tool",
      server: "crm",
      tool: "lookup",
      input: { email: "alice@example.com" },
    },
    "{}",
    { depth: 0 }
  )

  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.doesNotMatch(call.prompt, /alice@example\.com/)
    assert.match(call.prompt, /EMAIL/)
  }
})

test("native hook executor redacts nested tool results before model reinjection", async () => {
  const calls = []
  const execute = createNativeHookExecutor({
    queryFn: fakeQuery(
      [{ type: "result", subtype: "success", is_error: false, result: "{}" }],
      calls
    ),
  })
  await execute({ type: "agent", prompt: "review" }, "{}", { depth: 0 })

  const postToolUse = calls[0].options.hooks.PostToolUse[0].hooks[0]
  const output = await postToolUse({ tool_response: { owner: "alice@example.com" } })
  const redacted = output.hookSpecificOutput.updatedToolOutput
  assert.doesNotMatch(JSON.stringify(redacted), /alice@example\.com/)
  assert.match(JSON.stringify(redacted), /EMAIL/)
})

test("native hook executor fails closed when PII remains after redaction", async () => {
  const calls = []
  let gatePasses = true
  const execute = createNativeHookExecutor({
    queryFn: fakeQuery(
      [{ type: "result", subtype: "success", is_error: false, result: "{}" }],
      calls
    ),
    redact: (value) => value,
    piiGate: () => gatePasses,
  })

  gatePasses = false
  assert.deepEqual(
    await execute({ type: "prompt", prompt: "alice@example.com" }, "{}", { depth: 0 }),
    { block: "Hook data blocked by the PII redaction gate" }
  )
  assert.equal(calls.length, 0)

  gatePasses = true
  await execute({ type: "agent", prompt: "review" }, "{}", { depth: 0 })
  gatePasses = false
  const postToolUse = calls[0].options.hooks.PostToolUse[0].hooks[0]
  assert.deepEqual(await postToolUse({ tool_response: "alice@example.com" }), {
    decision: "block",
    reason: "Hook data blocked by the PII redaction gate",
  })
})

test("native hook executor rejects PII-bearing tool identifiers and failure output", async () => {
  const calls = []
  const execute = createNativeHookExecutor({
    queryFn: fakeQuery(
      [{ type: "result", subtype: "success", is_error: false, result: "{}" }],
      calls
    ),
  })

  assert.deepEqual(
    await execute(
      { type: "mcp_tool", server: "alice@example.com", tool: "lookup", input: {} },
      "{}",
      { depth: 0 }
    ),
    { block: "Hook data blocked by the PII redaction gate" }
  )
  assert.equal(calls.length, 0)

  await execute({ type: "agent", prompt: "review" }, "{}", { depth: 0 })
  const postToolFailure = calls[0].options.hooks.PostToolUseFailure[0].hooks[0]
  assert.deepEqual(await postToolFailure({ error: "owner alice@example.com is unavailable" }), {
    decision: "block",
    reason: "Hook data blocked by the PII redaction gate",
  })
  assert.deepEqual(await postToolFailure({ error: "tool unavailable" }), {})
})

test("native MCP handler only exposes the configured namespaced tool", async () => {
  const calls = []
  const execute = createNativeHookExecutor({
    queryFn: fakeQuery(
      [
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "{}",
          total_cost_usd: 0,
        },
      ],
      calls
    ),
  })
  await execute({ type: "mcp_tool", server: "fs", tool: "read", input: { path: "a" } }, "{}", {
    depth: 0,
  })
  assert.deepEqual(calls[0].options.allowedTools, ["mcp__fs__read"])
  assert.equal(calls[0].options.maxTurns, 2)
})

test("native hook executor blocks exhausted budget and refuses recursion", async () => {
  const budget = createHookBudgetGovernor(0.1)
  budget.record(0.1)
  const execute = createNativeHookExecutor({ budget, queryFn: () => assert.fail("must not query") })
  assert.deepEqual(await execute({ type: "agent", prompt: "x" }, "{}", { depth: 0 }), {
    block: "Hook model budget exhausted",
  })

  const fresh = createNativeHookExecutor({ queryFn: () => assert.fail("must not query") })
  assert.deepEqual(await fresh({ type: "prompt", prompt: "x" }, "{}", { depth: 1 }), {
    warning: "hook recursion depth exceeded (maximum 1)",
  })
})
