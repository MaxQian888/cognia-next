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

test("native hook executor disables nested hooks and constrains prompt handlers", async () => {
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
  assert.equal(calls[0].options.hooks, undefined)
  assert.deepEqual(calls[0].options.allowedTools, [])
  assert.equal(calls[0].options.maxTurns, 1)
  assert.match(calls[0].prompt, /hook-origin depth="1"/)
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
