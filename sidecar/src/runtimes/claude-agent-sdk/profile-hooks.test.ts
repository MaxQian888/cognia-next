import { test } from "node:test"
import assert from "node:assert/strict"

import type { ApprovalAnswer } from "../../policy/permission/approval.ts"
import { createAnthropicCanUseTool } from "../../policy/permission/sdk-can-use-tool.ts"
import type { PendingApproval } from "../../policy/permission/approval.ts"
import { buildProfileToolHooks } from "./profile-hooks.ts"

const CEILING = { workspace: "sandbox", outbound: "ask", secrets: "ask", hostConfig: "ask" }
const PLUGINS = [{ name: "im_send", pluginId: "acme", permissionClasses: ["outbound"] }]
const OUTBOUND = "mcp__cognia-plugin-tools__im_send"

type Hook = (
  input: Record<string, unknown>,
  toolUseID: string | undefined,
  options: { signal: AbortSignal }
) => Promise<Record<string, unknown>>

function hookOf(hooks: ReturnType<typeof buildProfileToolHooks>): Hook {
  assert.ok(hooks, "a profile turn gets the hook")
  return hooks.PreToolUse[0]!.hooks[0] as unknown as Hook
}

function setup(sendOptions: Record<string, unknown>, answer: ApprovalAnswer) {
  const asked: Array<{ tool: string; id: string }> = []
  const approvals = new Set<string>()
  const hooks = buildProfileToolHooks({
    sendOptions: { pluginTools: PLUGINS, ...sendOptions },
    pluginToolNameAliases: new Map(),
    profileApprovals: approvals,
    canUseTool: async (tool, _input, ctx) => {
      asked.push({ tool, id: ctx.toolUseID })
      return answer
    },
  })
  return { hook: hookOf(hooks), asked, approvals }
}

const signal = new AbortController().signal

test("a turn without a profile gets no hook", () => {
  assert.equal(
    buildProfileToolHooks({
      sendOptions: { permissionMode: "bypassPermissions" },
      pluginToolNameAliases: new Map(),
      profileApprovals: new Set(),
      canUseTool: async () => ({ behavior: "allow" }),
    }),
    undefined
  )
})

test("a denied class is refused before the SDK's bypass can approve it", async () => {
  const { hook, asked } = setup(
    { permissionMode: "bypassPermissions", permissionProfile: { ...CEILING, workspace: "deny" } },
    { behavior: "allow" }
  )
  const out = await hook({ tool_name: "Bash", tool_input: { command: "ls" } }, "tu-1", { signal })
  assert.equal(
    (out.hookSpecificOutput as { permissionDecision: string }).permissionDecision,
    "deny"
  )
  assert.match(
    (out.hookSpecificOutput as { permissionDecisionReason: string }).permissionDecisionReason,
    /workspace file and shell operations/
  )
  assert.deepEqual(asked, [])
})

test("an outbound call asks a person even under bypass, and the approval is handed over", async () => {
  const { hook, asked, approvals } = setup(
    { permissionMode: "bypassPermissions", permissionProfile: CEILING },
    { behavior: "allow", updatedInput: { text: "hi" } }
  )
  const out = await hook({ tool_name: OUTBOUND, tool_input: { text: "hi" } }, "tu-2", { signal })
  assert.deepEqual(asked, [{ tool: OUTBOUND, id: "tu-2" }])
  assert.deepEqual(out.hookSpecificOutput, {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    permissionDecisionReason: "approved by a person for this unattended run",
    updatedInput: { text: "hi" },
  })
  assert.ok(approvals.has("tu-2"))
})

test("a refused or timed-out ask denies the call", async () => {
  const { hook, approvals } = setup(
    { permissionProfile: CEILING },
    {
      behavior: "deny",
      message: "denied: nobody approved this tool call before the approval timed out",
    }
  )
  const out = await hook({ tool_name: OUTBOUND, tool_input: {} }, "tu-3", { signal })
  assert.deepEqual(out.hookSpecificOutput, {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason:
      "denied: nobody approved this tool call before the approval timed out",
  })
  assert.equal(approvals.size, 0)
})

test("workspace and unclassed calls are left to the SDK and the ladder", async () => {
  const { hook, asked } = setup({ permissionProfile: CEILING }, { behavior: "allow" })
  assert.deepEqual(await hook({ tool_name: "Write", tool_input: {} }, "tu-4", { signal }), {})
  assert.deepEqual(
    await hook({ tool_name: "mcp__github__x", tool_input: {} }, "tu-5", { signal }),
    {}
  )
  assert.deepEqual(asked, [])
})

test("canUseTool honours a hook approval once and then asks again", async () => {
  const pending = new Map<string, PendingApproval>()
  const frames: Array<Record<string, unknown>> = []
  const approvals = new Set(["tu-6"])
  const canUseTool = createAnthropicCanUseTool({
    sendOptions: { permissionProfile: CEILING, pluginTools: PLUGINS, permissionMode: "default" },
    sessionId: "s1",
    emit: (frame) => frames.push(frame),
    log: () => {},
    pendingApprovals: pending,
    pluginToolNameAliases: new Map(),
    doomGuard: { check: () => null },
    profileApprovals: approvals,
  })
  const input = { text: "hi" }
  assert.deepEqual(await canUseTool(OUTBOUND, input, { toolUseID: "tu-6", signal }), {
    behavior: "allow",
    updatedInput: input,
  })
  assert.equal(frames.length, 0, "no second prompt for the same call")
  assert.equal(approvals.size, 0, "consumed")
  const second = canUseTool(OUTBOUND, input, { toolUseID: "tu-6", signal })
  assert.equal(frames.length, 1, "a later call with the same id asks again")
  const [requestId, waiter] = [...pending][0]!
  pending.delete(requestId)
  waiter.resolve({ behavior: "deny", message: "no" })
  assert.deepEqual(await second, { behavior: "deny", message: "no" })
})
