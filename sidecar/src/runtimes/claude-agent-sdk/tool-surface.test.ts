import { test } from "node:test"
import assert from "node:assert/strict"
import { BUILTIN_TOOL_NAMES, LEGACY_TOOL_NAME_ALIASES } from "@anthropic-ai/claude-agent-sdk"
import {
  enforceAnthropicToolSurface,
  applySdkToolPermissionPolicies,
  normalizeClaudeToolNames,
} from "./tool-surface.ts"

test("native tool aliases normalize against the installed SDK catalog", () => {
  const entries = Object.entries(LEGACY_TOOL_NAME_ALIASES)
  assert.ok(entries.length > 0)
  assert.deepEqual(
    normalizeClaudeToolNames(entries.map(([alias]) => alias)),
    entries.map(([, canonical]) => canonical)
  )
  assert.deepEqual(normalizeClaudeToolNames([...BUILTIN_TOOL_NAMES]), [...BUILTIN_TOOL_NAMES])
})

test("alias normalization preserves exact permission suffixes and MCP namespaces", () => {
  const [alias, canonical] = Object.entries(LEGACY_TOOL_NAME_ALIASES)[0]!
  const suffix = "(research:*,literal(value))"
  const mcp = `mcp__workspace__${alias}`
  const unknown = "SomeFutureNativeTool(value:*)"
  const names = [`${alias}${suffix}`, mcp, `${mcp}(*)`, unknown, "toString"]
  assert.deepEqual(normalizeClaudeToolNames(names), [
    `${canonical}${suffix}`,
    mcp,
    `${mcp}(*)`,
    unknown,
    "toString",
  ])
  assert.deepEqual(names, [`${alias}${suffix}`, mcp, `${mcp}(*)`, unknown, "toString"])
  assert.equal(normalizeClaudeToolNames(undefined), undefined)
  assert.deepEqual(normalizeClaudeToolNames([]), [])
})

test("normalizing both deny and allow rules keeps canonical denial targets equivalent", () => {
  for (const [alias, canonical] of Object.entries(LEGACY_TOOL_NAME_ALIASES)) {
    const deny = normalizeClaudeToolNames([`${alias}(*)`])!
    const allow = normalizeClaudeToolNames([`${canonical}(*)`])!
    assert.deepEqual(deny, allow)
  }
})

test("portable tool policies translate on SDK server registrations without weakening native deny", () => {
  const instance = { fixture: true }
  const original = {
    bridge: {
      type: "sdk",
      instance,
      tools: [{ name: "remove", permission_policy: "always_deny" }],
    },
    relay: { type: "stdio", command: "node" },
  }
  const result = applySdkToolPermissionPolicies(original, [
    { tool: "mcp__bridge__publish", decision: "ask" },
    { tool: "mcp__bridge__remove", decision: "ask" },
    { tool: "mcp__relay__publish", decision: "deny" },
  ])
  assert.equal(result.bridge.instance, instance)
  assert.deepEqual(result.bridge.tools, [
    { name: "publish", permission_policy: "always_ask" },
    { name: "remove", permission_policy: "always_deny" },
  ])
  assert.equal(result.relay, original.relay)
  assert.deepEqual(original.bridge.tools, [{ name: "remove", permission_policy: "always_deny" }])
})

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
  const original = { tools: ["Read"], mcpServers: { safe: { command: "test" } } }
  assert.equal(enforceAnthropicToolSurface(original, {}), original)
})
