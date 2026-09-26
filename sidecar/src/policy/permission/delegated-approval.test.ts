// Delegated approval: with a permission prompt tool configured, Cognia's hard
// authority moves into PreToolUse hooks that deny first, re-check rewritten
// input and strip hook pre-approvals.

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  enforceAnthropicPermissionChannel,
  permissionDecisionHasUnprovenRewrite,
} from "./delegated-approval.ts"
import type { DelegatingSdkOptions, HookOutput, PreToolUseHook } from "./delegated-approval.ts"

/** Hook `hook` of PreToolUse matcher `matcher` (negative indexes count from the end). */
function preToolUseHook(options: DelegatingSdkOptions, matcher: number, hook = 0): PreToolUseHook {
  const found = options.hooks?.PreToolUse?.at(matcher)?.hooks[hook]
  assert.ok(found, `PreToolUse[${matcher}].hooks[${hook}] exists`)
  return found
}

/** The permission decision a hook returned, if any. */
async function decisionOf(
  result: Promise<HookOutput | undefined> | HookOutput | undefined
): Promise<unknown> {
  return (await result)?.hookSpecificOutput?.permissionDecision
}

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
  const guard = preToolUseHook(options, -1)
  const context = { signal: new AbortController().signal }
  const denied = guard(
    {
      tool_name: "mcp__cognia-tools__write",
      tool_input: { path: "/workspace/a", content: "safe" },
    },
    "one",
    context
  )
  assert.equal(await decisionOf(denied), "deny")
  assert.deepEqual(
    await guard({ tool_name: "Read", tool_input: { path: "/workspace/a" } }, "two", context),
    {}
  )
  assert.equal(
    await decisionOf(
      guard({ tool_name: "Read", tool_input: { content: "private@example.com" } }, "three", context)
    ),
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
  const unsafe = preToolUseHook(options, 0, 0)
  const safe = preToolUseHook(options, 0, 1)
  const input = { tool_name: "Read", tool_input: {} },
    context = { signal: new AbortController().signal }
  assert.equal(await decisionOf(unsafe(input, "id", context)), "deny")
  const allowed = await safe(input, "id", context)
  assert.ok(allowed?.hookSpecificOutput, "the rewrite survives without its pre-approval")
  assert.equal(allowed.hookSpecificOutput.permissionDecision, undefined)
  const aborted = new AbortController()
  aborted.abort()
  assert.equal(await decisionOf(safe(input, "id", { signal: aborted.signal })), "deny")
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

test("the response guard covers encoded plugin JSON and unprovable originals", () => {
  assert.equal(
    permissionDecisionHasUnprovenRewrite(
      JSON.stringify({ behavior: "allow", updatedInput: { path: "/unsafe" } }),
      { path: "/safe" }
    ),
    true
  )
  assert.equal(
    permissionDecisionHasUnprovenRewrite({ behavior: "allow", updatedInput: {} }, undefined),
    true
  )
  assert.equal(
    permissionDecisionHasUnprovenRewrite({ behavior: "deny", message: "No" }, undefined),
    false
  )
})

test("the response guard reads text blocks and structured content, and allows an unchanged input", () => {
  const input = { path: "/safe" }
  const allow = JSON.stringify({ behavior: "allow", updatedInput: input })
  // A JSON answer split across text blocks is read joined.
  const split = {
    content: [
      { type: "text", text: allow.slice(0, 9) },
      { type: "text", text: allow.slice(9) },
    ],
  }
  assert.equal(permissionDecisionHasUnprovenRewrite(split, input), false)
  assert.equal(permissionDecisionHasUnprovenRewrite(split, { path: "/other" }), true)
  assert.equal(
    permissionDecisionHasUnprovenRewrite(
      { structuredContent: { updatedInput: { path: "/unsafe" } } },
      input
    ),
    true
  )
  // Non-JSON text and non-text blocks are ignored.
  assert.equal(
    permissionDecisionHasUnprovenRewrite(
      { content: [{ type: "text", text: "allow" }, null, { type: "image", text: allow }] },
      { path: "/other" }
    ),
    false
  )
})
