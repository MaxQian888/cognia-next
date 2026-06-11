// Tests for the AI SDK tool bridge: converts built-in tool defs + plugin tool
// manifests into native AI SDK tools for the non-Anthropic dispatch path.

import { test } from "node:test"
import assert from "node:assert/strict"
import { buildAiSdkTools, createToolPermissionGate, __testing__ } from "./ai-sdk-tools.mjs"

test("buildAiSdkTools registers built-in tools for enabled categories only", () => {
  const tools = buildAiSdkTools({
    sendOptions: { builtinTools: { git: true, process: false } },
    emit: () => {},
    sessionId: "s1",
  })
  // git category contributes git_status / git_diff / git_log …
  assert.ok(tools.git_status, "git_status present when git enabled")
  // process category disabled → its tools absent.
  assert.equal(tools.process_list ?? tools.list_processes, undefined)
})

test("buildAiSdkTools returns no built-in tools when builtinTools is absent", () => {
  const tools = buildAiSdkTools({ sendOptions: {}, emit: () => {}, sessionId: "s1" })
  assert.equal(Object.keys(tools).length, 0)
})

test("buildAiSdkTools wires plugin tools that round-trip through the renderer", async () => {
  const emitted = []
  const pendingPluginToolCalls = new Map()
  const tools = buildAiSdkTools({
    sendOptions: {
      pluginTools: [
        {
          name: "my_plugin_tool",
          description: "does a thing",
          jsonSchema: { type: "object", properties: { q: { type: "string" } } },
          pluginId: "p1",
        },
      ],
    },
    emit: (m) => emitted.push(m),
    sessionId: "s1",
    pendingPluginToolCalls,
  })
  assert.ok(tools.my_plugin_tool, "plugin tool registered")

  // Kick off execute; it should emit a plugin_tool_exec and await a response.
  const execPromise = tools.my_plugin_tool.execute({ q: "hi" })
  // Let the microtask register the pending call.
  await Promise.resolve()
  const event = emitted.find((m) => m.type === "plugin_tool_exec")
  assert.ok(event, "plugin_tool_exec emitted")
  assert.equal(event.name, "my_plugin_tool")
  assert.deepEqual(event.args, { q: "hi" })
  assert.equal(pendingPluginToolCalls.size, 1)

  // Resolve the round-trip the way claude-host's plugin_tool_response would.
  const pending = pendingPluginToolCalls.get(event.toolUseId)
  pending.resolve({ result: "plugin says hi" })
  const result = await execPromise
  assert.equal(result, "plugin says hi")
})

test("plugin tool execute throws on an error response", async () => {
  const pendingPluginToolCalls = new Map()
  const tools = buildAiSdkTools({
    sendOptions: {
      pluginTools: [
        { name: "boom", description: "", jsonSchema: { type: "object" }, pluginId: "p" },
      ],
    },
    emit: () => {},
    sessionId: "s1",
    pendingPluginToolCalls,
  })
  const execPromise = tools.boom.execute({})
  await Promise.resolve()
  const [, pending] = [...pendingPluginToolCalls.entries()][0]
  pending.resolve({ error: "plugin failed" })
  await assert.rejects(execPromise, /plugin failed/)
})

test("buildAiSdkTools returns keys in sorted order regardless of registration order", () => {
  const tools = buildAiSdkTools({
    sendOptions: {
      builtinTools: { git: true },
      pluginTools: [
        { name: "zz_last", description: "", jsonSchema: { type: "object" }, pluginId: "p" },
        { name: "aa_first", description: "", jsonSchema: { type: "object" }, pluginId: "p" },
      ],
    },
    emit: () => {},
    sessionId: "s1",
    pendingPluginToolCalls: new Map(),
  })
  const keys = Object.keys(tools)
  assert.ok(keys.length > 2, "built-in + plugin tools present")
  assert.deepEqual(keys, [...keys].sort(), "tools map keys are sorted")
  assert.ok(keys.includes("aa_first") && keys.includes("zz_last"))
})

test("createToolPermissionGate: bypassPermissions allows without prompting", async () => {
  let emitted = 0
  const gate = createToolPermissionGate({
    emit: () => emitted++,
    sessionId: "s1",
    pendingApprovals: new Map(),
    sendOptions: { permissionMode: "bypassPermissions" },
  })
  await gate("mcp__cognia-tools__git_status", { a: 1 })
  assert.equal(emitted, 0)
})

test("createToolPermissionGate: bypass does NOT disarm the doom-loop guard", async () => {
  // A doomed (Nth identical) call must still round-trip even under bypass.
  let emitted = 0
  const pending = new Map()
  const gate = createToolPermissionGate({
    emit: (ev) => {
      emitted++
      // Auto-approve so the awaited promise resolves.
      const { requestId } = ev
      queueMicrotask(() => pending.get(requestId)?.resolve({ behavior: "allow" }))
    },
    sessionId: "s1",
    pendingApprovals: pending,
    sendOptions: { permissionMode: "bypassPermissions" },
    doomGuard: { check: () => "ask" },
  })
  await gate("mcp__cognia-tools__git_status", { a: 1 })
  assert.equal(emitted, 1, "doomed call under bypass must round-trip, not silently allow")
})

test("createToolPermissionGate: plan mode allows read-only, denies mutating + plugin tools", async () => {
  const gate = createToolPermissionGate({
    emit: () => {},
    sessionId: "s1",
    pendingApprovals: new Map(),
    sendOptions: { permissionMode: "plan" },
  })
  // Read-only built-in → allowed.
  await gate("mcp__cognia-tools__git_status", {})
  // Mutating built-in → denied.
  await assert.rejects(gate("mcp__cognia-tools__write", {}), /plan mode/)
  // Plugin tool → denied even if its bare name looks read-only.
  await assert.rejects(gate("mcp__cognia-plugin-tools__grep", {}), /plan mode/)
})

test("createToolPermissionGate: ruleset allow short-circuits, deny throws", async () => {
  const gate = createToolPermissionGate({
    emit: () => {},
    sessionId: "s1",
    pendingApprovals: new Map(),
    sendOptions: {
      permissionRuleset: { "*": "deny" },
    },
  })
  await assert.rejects(gate("mcp__cognia-tools__git_status", {}), /denied/)
})

test("createToolPermissionGate: prompts and resolves via pendingApprovals", async () => {
  const events = []
  const pendingApprovals = new Map()
  const gate = createToolPermissionGate({
    emit: (m) => events.push(m),
    sessionId: "s1",
    pendingApprovals,
    sendOptions: {},
  })
  const p = gate("mcp__cognia-tools__git_status", { x: 1 })
  await Promise.resolve()
  const req = events.find((e) => e.type === "permission_request")
  assert.ok(req)
  assert.equal(req.toolName, "mcp__cognia-tools__git_status")
  assert.equal(pendingApprovals.size, 1)
  // Approve with an updated input, the way claude-host's handler would.
  pendingApprovals.get(req.requestId).resolve({ behavior: "allow", updatedInput: { x: 2 } })
  assert.deepEqual(await p, { x: 2 })
})

test("createToolPermissionGate: a denied prompt rejects", async () => {
  const events = []
  const pendingApprovals = new Map()
  const gate = createToolPermissionGate({
    emit: (m) => events.push(m),
    sessionId: "s1",
    pendingApprovals,
    sendOptions: {},
  })
  const p = gate("mcp__cognia-tools__git_status", {})
  await Promise.resolve()
  const req = events.find((e) => e.type === "permission_request")
  pendingApprovals.get(req.requestId).resolve({ behavior: "deny", message: "nope" })
  await assert.rejects(p, /nope/)
})

test("buildAiSdkTools gates a built-in tool through the permission gate (deny blocks handler)", async () => {
  const pendingApprovals = new Map()
  const tools = buildAiSdkTools({
    sendOptions: {
      builtinTools: { git: true },
      permissionRuleset: { "*": "deny" },
    },
    emit: () => {},
    sessionId: "s1",
    pendingApprovals,
  })
  // git_status execute should be blocked by the deny ruleset before running.
  await assert.rejects(tools.git_status.execute({ cwd: "/tmp" }), /denied/)
})

test("coreFiles tools are registered on the ai-sdk path when enabled + tracked", () => {
  const tools = buildAiSdkTools({
    sendOptions: { builtinTools: { coreFiles: true }, cwd: "." },
    emit: () => {},
    sessionId: "s1",
    readTracker: { record() {}, hasRead: () => false, assertReadBefore() {}, clear() {} },
  })
  for (const name of [
    "grep",
    "glob",
    "read",
    "ls",
    "edit",
    "multi_edit",
    "write",
    "bash",
    "TodoWrite",
  ]) {
    assert.ok(tools[name], `${name} registered`)
  }
})

test("coreFiles tools are absent without a readTracker or when category disabled", () => {
  const noTracker = buildAiSdkTools({
    sendOptions: { builtinTools: { coreFiles: true }, cwd: "." },
    emit: () => {},
    sessionId: "s1",
  })
  assert.equal(noTracker.grep, undefined)
  const disabled = buildAiSdkTools({
    sendOptions: { builtinTools: { coreFiles: false }, cwd: "." },
    emit: () => {},
    sessionId: "s1",
    readTracker: { record() {} },
  })
  assert.equal(disabled.grep, undefined)
})

test("disallowedTools filters built-in tools by bare and namespaced names", () => {
  const tracker = { record() {}, hasRead: () => false, assertReadBefore() {}, clear() {} }
  const tools = buildAiSdkTools({
    sendOptions: {
      builtinTools: { coreFiles: true, git: true },
      cwd: ".",
      disallowedTools: ["bash", "mcp__cognia-tools__write", "mcp__cognia-tools__git_status"],
    },
    emit: () => {},
    sessionId: "s1",
    readTracker: tracker,
  })
  assert.equal(tools.bash, undefined, "bare name denied")
  assert.equal(tools.write, undefined, "namespaced name denied")
  assert.equal(tools.git_status, undefined, "namespaced builtin denied")
  assert.ok(tools.read, "undenied tools remain")
  assert.ok(tools.git_diff, "undenied git tools remain")
})

test("disallowedTools filters plugin tools too", () => {
  const tools = buildAiSdkTools({
    sendOptions: {
      pluginTools: [
        { name: "keep_me", description: "", jsonSchema: { type: "object" }, pluginId: "p" },
        { name: "drop_me", description: "", jsonSchema: { type: "object" }, pluginId: "p" },
      ],
      disallowedTools: ["mcp__cognia-plugin-tools__drop_me"],
    },
    emit: () => {},
    sessionId: "s1",
    pendingPluginToolCalls: new Map(),
  })
  assert.ok(tools.keep_me)
  assert.equal(tools.drop_me, undefined)
})

test("doom-loop guard forces a prompt on the third identical allowed call", async () => {
  const events = []
  const pendingApprovals = new Map()
  const { createDoomLoopGuard } = await import("./doom-loop.mjs")
  const gate = createToolPermissionGate({
    emit: (m) => events.push(m),
    sessionId: "s1",
    pendingApprovals,
    sendOptions: { permissionRuleset: { "*": "allow" } },
    doomGuard: createDoomLoopGuard(),
  })
  // First two identical calls sail through the allow rule.
  assert.deepEqual(await gate("t", { q: 1 }), { q: 1 })
  assert.deepEqual(await gate("t", { q: 1 }), { q: 1 })
  // Third must round-trip.
  const p = gate("t", { q: 1 })
  await Promise.resolve()
  const req = events.find((e) => e.type === "permission_request")
  assert.ok(req, "third identical call prompts despite the allow rule")
  pendingApprovals.get(req.requestId).resolve({ behavior: "allow" })
  await p
})

test("builtinDefToAiSdkTool returns joined text and throws on isError", async () => {
  const { builtinDefToAiSdkTool, callToolResultToText } = __testing__
  assert.equal(
    callToolResultToText({
      content: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
    }),
    "a\nb"
  )
  const okTool = builtinDefToAiSdkTool({
    name: "ok",
    description: "",
    inputSchema: {},
    handler: async () => ({ content: [{ type: "text", text: "done" }] }),
  })
  assert.equal(await okTool.execute({}), "done")

  const errTool = builtinDefToAiSdkTool({
    name: "err",
    description: "",
    inputSchema: {},
    handler: async () => ({ content: [{ type: "text", text: "nope" }], isError: true }),
  })
  await assert.rejects(errTool.execute({}), /nope/)
})
