import assert from "node:assert/strict"
import { test } from "node:test"
import { captureClaudeRuntime } from "../../../test-support/claude-runtime.ts"

test("nested options and interaction callbacks reach the SDK after the final deny-all clamp", async () => {
  const { options, session, events } = captureClaudeRuntime(
    {
      model: "model",
      fallbackModel: "fallback",
      systemPrompt: "base",
      appendSystemPrompt: "dynamic",
      claudeAgentSdk: {
        version: 1,
        tools: ["Bash"],
        title: "nested title",
        elicitation: { enabled: true },
      },
    },
    () => ({ async *[Symbol.asyncIterator]() {}, interrupt() {}, close() {} })
  )
  assert.equal(options.title, "nested title")
  assert.equal(options.model, "model")
  assert.equal(options.fallbackModel, "fallback")
  assert.deepEqual(options.tools, [])
  assert.deepEqual(options.mcpServers, {})
  assert.equal(options.hooks, undefined)
  assert.equal(typeof options.onElicitation, "function")
  assert.ok(options.systemPrompt)
  assert.equal(
    events.some((event) => event.type === "sdk_option_warning"),
    false
  )
  session.closeInput()
})
