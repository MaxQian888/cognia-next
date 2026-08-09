import { test } from "node:test"
import assert from "node:assert/strict"
import { enforceAnthropicToolSurface } from "./anthropic.mjs"

test("disabled tool surface removes every SDK tool entry point", () => {
  const options = enforceAnthropicToolSurface(
    {
      tools: ["Read", "Bash"],
      allowedTools: ["Read"],
      mcpServers: { unsafe: { type: "stdio", command: "unsafe" } },
      agents: { helper: { description: "helper", prompt: "help" } },
      agent: "helper",
      hooks: { PreToolUse: [] },
    },
    { toolSurface: "none" }
  )

  assert.deepEqual(options.tools, [])
  assert.deepEqual(options.allowedTools, [])
  assert.deepEqual(options.mcpServers, {})
  assert.equal(options.agents, undefined)
  assert.equal(options.agent, undefined)
  assert.equal(options.hooks, undefined)
})

test("default tool surface preserves SDK options", () => {
  const original = { tools: ["Read"], mcpServers: { safe: {} } }
  assert.equal(enforceAnthropicToolSurface(original, {}), original)
})
