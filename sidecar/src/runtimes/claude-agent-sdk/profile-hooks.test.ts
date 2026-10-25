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

test("portable tool policies bind before SDK bypass without an unattended profile", async () => {
  const tool = "mcp__github__publish"
  const { hook, asked } = setup(
    { permissionMode: "bypassPermissions", toolPermissionRules: [{ tool, decision: "ask" }] },
    { behavior: "allow" }
  )
  await hook({ tool_name: tool, tool_input: {} }, "policy-1", { signal })
  assert.deepEqual(asked, [{ tool, id: "policy-1" }])
  const denied = setup(
    { permissionMode: "bypassPermissions", toolPermissionRules: [{ tool, decision: "deny" }] },
    { behavior: "allow" }
  )
  const out = await denied.hook({ tool_name: tool, tool_input: {} }, "policy-2", { signal })
  assert.equal(
    (out.hookSpecificOutput as { permissionDecision: string }).permissionDecision,
    "deny"
  )
  assert.deepEqual(denied.asked, [])
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
    permissionDecisionReason: "approved by a person for this tool call",
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

test("a mode's MCP allowlist installs the hook and refuses unpicked tools under bypass", async () => {
  const { hook, asked } = setup(
    { permissionMode: "bypassPermissions", mcpToolAllowlist: { search: ["query"] } },
    { behavior: "allow" }
  )
  const out = await hook({ tool_name: "mcp__search__added_later", tool_input: {} }, "m-1", {
    signal,
  })
  assert.equal(
    (out.hookSpecificOutput as { permissionDecision: string }).permissionDecision,
    "deny"
  )
  assert.deepEqual(
    await hook({ tool_name: "mcp__search__query", tool_input: {} }, "m-2", { signal }),
    {}
  )
  assert.deepEqual(asked, [])
})

// ADR-0239: outbound tools listed in `alwaysExplicitTools`.
const IM_SEND = "mcp__cognia-plugin-tools__im_broadcast"

function explicitHooks(mode: "observe" | "enforce", seen = new Set<string>()) {
  const asked: string[] = []
  const frames: Array<Record<string, unknown>> = []
  const hooks = buildProfileToolHooks({
    sendOptions: {
      permissionMode: "bypassPermissions",
      alwaysExplicitTools: ["im_broadcast"],
      alwaysExplicitToolsMode: mode,
    },
    pluginToolNameAliases: new Map(),
    profileApprovals: new Set(),
    explicitSeen: seen,
    emit: (frame) => frames.push(frame),
    sessionId: "s1",
    canUseTool: async (tool) => {
      asked.push(tool)
      return { behavior: "allow" }
    },
  })
  assert.ok(hooks, "an always-explicit list gets the hooks")
  return { hooks, asked, frames, seen }
}

type PostHook = (input: Record<string, unknown>, toolUseID: string | undefined) => Promise<unknown>

test("an enforced outbound tool asks before the SDK's bypass can run it", async () => {
  const { hooks, asked } = explicitHooks("enforce")
  const pre = hooks.PreToolUse[0]!.hooks[0] as unknown as Hook
  const out = await pre({ tool_name: IM_SEND, tool_input: {} }, "tu-1", { signal })
  assert.deepEqual(asked, [IM_SEND])
  assert.equal(
    (out.hookSpecificOutput as { permissionDecision: string }).permissionDecision,
    "allow"
  )
  assert.equal(hooks.PostToolUse, undefined)
  // An unlisted tool is left to the SDK.
  assert.deepEqual(await pre({ tool_name: "Bash", tool_input: {} }, "tu-2", { signal }), {})
})

test("an observed outbound tool the SDK ran without asking is reported after it ran", async () => {
  const { hooks, asked, frames, seen } = explicitHooks("observe")
  const pre = hooks.PreToolUse[0]!.hooks[0] as unknown as Hook
  assert.deepEqual(await pre({ tool_name: IM_SEND, tool_input: {} }, "tu-1", { signal }), {})
  assert.deepEqual(asked, [])

  const post = hooks.PostToolUse![0]!.hooks[0] as unknown as PostHook
  await post({ tool_name: IM_SEND, tool_input: { text: "hi" } }, "tu-1")
  assert.deepEqual(frames, [
    {
      type: "explicit_tool_allowed",
      sessionId: "s1",
      toolUseID: "tu-1",
      toolName: IM_SEND,
      input: { text: "hi" },
      permissionClass: "outbound",
    },
  ])

  // A call canUseTool already allowed or reported is not reported again.
  seen.add("tu-2")
  await post({ tool_name: IM_SEND, tool_input: {} }, "tu-2")
  await post({ tool_name: "Bash", tool_input: {} }, "tu-3")
  assert.equal(frames.length, 1)
  assert.equal(seen.size, 0)
})

// ADR-0239 phase 2: shell calls with a `gh` write, in their own mode.
function shellWriteHooks(mode: "observe" | "enforce") {
  const asked: string[] = []
  const frames: Array<Record<string, unknown>> = []
  const hooks = buildProfileToolHooks({
    sendOptions: { permissionMode: "bypassPermissions", alwaysExplicitGithubWritesMode: mode },
    pluginToolNameAliases: new Map(),
    profileApprovals: new Set(),
    explicitSeen: new Set(),
    emit: (frame) => frames.push(frame),
    sessionId: "s1",
    canUseTool: async (tool) => {
      asked.push(tool)
      return { behavior: "allow" }
    },
  })
  assert.ok(hooks, "a shell-writes mode alone gets the hooks")
  return { hooks, asked, frames }
}

test("an enforced shell gh write asks before the SDK's bypass can run it", async () => {
  const { hooks, asked } = shellWriteHooks("enforce")
  const pre = hooks.PreToolUse[0]!.hooks[0] as unknown as Hook
  await pre({ tool_name: "Bash", tool_input: { command: "gh pr create --fill" } }, "tu-1", {
    signal,
  })
  assert.deepEqual(asked, ["Bash"])
  assert.deepEqual(
    await pre({ tool_name: "Bash", tool_input: { command: "gh pr view 1" } }, "tu-2", { signal }),
    {}
  )
  assert.equal(hooks.PostToolUse, undefined)
})

test("an observed shell gh write the SDK ran is reported after it ran", async () => {
  const { hooks, asked, frames } = shellWriteHooks("observe")
  const pre = hooks.PreToolUse[0]!.hooks[0] as unknown as Hook
  const input = { command: "gh pr create --fill" }
  assert.deepEqual(await pre({ tool_name: "Bash", tool_input: input }, "tu-1", { signal }), {})
  assert.deepEqual(asked, [])
  const post = hooks.PostToolUse![0]!.hooks[0] as unknown as PostHook
  await post({ tool_name: "Bash", tool_input: input }, "tu-1")
  await post({ tool_name: "Bash", tool_input: { command: "ls" } }, "tu-2")
  assert.equal(frames.length, 1)
  assert.equal(frames[0]!.toolName, "Bash")
})
