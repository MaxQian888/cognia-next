import { test } from "node:test"
import assert from "node:assert/strict"
import {
  anthropicPluginToolBridgeOptions,
  enforceAnthropicToolSurface,
  enforceAnthropicPermissionChannel,
} from "./anthropic.mjs"

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

test("plugin tool bridge preserves the immutable sandbox runtime reference", () => {
  const options = anthropicPluginToolBridgeOptions({
    tools: [],
    emit: () => {},
    sessionId: "s1",
    turnId: "turn-1",
    attemptId: "attempt-2",
    sandboxRuntimeRef: "sandbox-runtime:anthropic",
    pendingPluginToolCalls: new Map(),
    alwaysLoad: true,
    alwaysLoadToolNames: new Set(),
  })

  assert.equal(options.sandboxRuntimeRef, "sandbox-runtime:anthropic")
  assert.equal(options.turnId, "turn-1")
  assert.equal(options.attemptId, "attempt-2")
})

test("plugin tool bridge forwards the alias table the dispatcher translates with", () => {
  const toolNameAliases = new Map()
  const options = anthropicPluginToolBridgeOptions({
    tools: [],
    emit: () => {},
    sessionId: "s1",
    pendingPluginToolCalls: new Map(),
    toolNameAliases,
  })
  assert.equal(options.toolNameAliases, toolNameAliases)
  const without = anthropicPluginToolBridgeOptions({
    tools: [],
    emit: () => {},
    sessionId: "s1",
    pendingPluginToolCalls: new Map(),
  })
  assert.equal("toolNameAliases" in without, false)
})

test("an explicit permission prompt tool excludes canUseTool while retaining independent interaction callbacks", () => {
  const callback = () => {},
    interaction = () => {}
  const options = {
    canUseTool: callback,
    onElicitation: interaction,
    permissionPromptToolName: "mcp__permission__review",
  }
  enforceAnthropicPermissionChannel(options)
  assert.equal(options.canUseTool, undefined)
  assert.equal(options.onElicitation, interaction)
  const normal = { canUseTool: callback }
  enforceAnthropicPermissionChannel(normal)
  assert.equal(normal.canUseTool, callback)
})

test("delegated permission retains hard plan denials and never preapproves a safe call", async () => {
  const options = enforceAnthropicPermissionChannel(
    { permissionPromptToolName: "mcp__permission__review", canUseTool() {} },
    { permissionMode: "plan" }
  )
  const guard = options.hooks.PreToolUse.at(-1).hooks[0]
  const context = { signal: new AbortController().signal }
  const denied = await guard(
    {
      tool_name: "mcp__cognia-tools__write",
      tool_input: { path: "/workspace/a", content: "safe" },
    },
    "one",
    context
  )
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny")
  assert.deepEqual(
    await guard({ tool_name: "Read", tool_input: { path: "/workspace/a" } }, "two", context),
    {}
  )
  assert.equal(
    (
      await guard(
        { tool_name: "Read", tool_input: { content: "private@example.com" } },
        "three",
        context
      )
    ).hookSpecificOutput.permissionDecision,
    "deny"
  )
})

test("delegated permission rechecks hook rewrites and removes hook autoapproval", async () => {
  const options = enforceAnthropicPermissionChannel({
    permissionPromptToolName: "mcp__permission__review",
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async () => ({
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "allow",
                updatedInput: { content: "private@example.com" },
              },
            }),
            async () => ({
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "allow",
                updatedInput: { content: "safe" },
              },
            }),
          ],
        },
      ],
    },
  })
  const [unsafe, safe] = options.hooks.PreToolUse[0].hooks
  const input = { tool_name: "Read", tool_input: {} },
    context = { signal: new AbortController().signal }
  assert.equal((await unsafe(input, "id", context)).hookSpecificOutput.permissionDecision, "deny")
  assert.equal((await safe(input, "id", context)).hookSpecificOutput.permissionDecision, undefined)
  const aborted = new AbortController()
  aborted.abort()
  assert.equal(
    (await safe(input, "id", { signal: aborted.signal })).hookSpecificOutput.permissionDecision,
    "deny"
  )
})

test("delegation cannot escape response guards through an implicitly loaded MCP server", () => {
  assert.throws(
    () =>
      enforceAnthropicPermissionChannel({
        permissionPromptToolName: "mcp__implicit__review",
        mcpServers: {},
      }),
    /managed MCP server/
  )
  const mounted = enforceAnthropicPermissionChannel({
    permissionPromptToolName: "mcp__mounted__review",
    mcpServers: { mounted: { type: "stdio", command: "node" } },
  })
  assert.equal(mounted.permissionPromptToolName, "mcp__mounted__review")
})
