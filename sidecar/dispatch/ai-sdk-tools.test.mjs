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
    // This test exercises the plugin round-trip, not the permission gate; the
    // gate is covered separately. bypassPermissions lets execute() proceed
    // without wiring a `pendingApprovals` channel.
    sendOptions: {
      permissionMode: "bypassPermissions",
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
      permissionMode: "bypassPermissions",
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

test("createToolPermissionGate: plan mode allows the exit_plan_mode signal tool", async () => {
  const gate = createToolPermissionGate({
    emit: () => {},
    sessionId: "s1",
    pendingApprovals: new Map(),
    sendOptions: { permissionMode: "plan" },
  })
  // The model must be able to submit its final plan even though every mutating
  // tool is blocked.
  await gate("mcp__cognia-tools__exit_plan_mode", { plan: "# Plan\n- a\n- b" })
})

test("createToolPermissionGate: plan mode allows the side-effect-free ask_user tool", async () => {
  const gate = createToolPermissionGate({
    emit: () => {},
    sessionId: "s1",
    pendingApprovals: new Map(),
    sendOptions: { permissionMode: "plan" },
  })
  // ask_user only pauses to ask the user a question — permitted in plan mode so
  // the agent can clarify before planning (parity with the Anthropic SDK), even
  // though it is a plugin tool on a non-builtin server.
  await gate("mcp__cognia-plugin-tools__ask_user", { question: "Which target?" })
  // Other plugin tools stay denied.
  await assert.rejects(gate("mcp__cognia-plugin-tools__grep", {}), /plan mode/)
})

test("createToolPermissionGate: ask_user is allowed without prompting in default mode", async () => {
  // Regression: ask_user IS the user interaction (the renderer's AskUserDialog
  // blocks until answered), so it must never round-trip through the generic
  // tool-approval modal. With no explicit ruleset/suppress entry it would
  // otherwise fall through to a permission_request — the bug this guards.
  const events = []
  const pendingApprovals = new Map()
  const gate = createToolPermissionGate({
    emit: (m) => events.push(m),
    sessionId: "s1",
    pendingApprovals,
    sendOptions: {}, // no mode, no ruleset, no suppress/alwaysAllow
  })
  const input = { question: "Which target?" }
  assert.deepEqual(await gate("mcp__cognia-plugin-tools__ask_user", input), input)
  assert.equal(
    events.some((e) => e.type === "permission_request"),
    false,
    "ask_user must not emit a permission_request"
  )
  assert.equal(pendingApprovals.size, 0)
})

test("createToolPermissionGate: reads permissionMode live so a mid-session set_mode takes effect", async () => {
  // Mutating sendOptions.permissionMode (as the claude_set_mode handler does)
  // must change the gate's decision WITHOUT rebuilding the gate.
  const sendOptions = { permissionMode: "plan" }
  const gate = createToolPermissionGate({
    emit: () => {},
    sessionId: "s1",
    pendingApprovals: new Map(),
    sendOptions,
  })
  // While in plan mode, a write is blocked.
  await assert.rejects(gate("mcp__cognia-tools__write", {}), /plan mode/)
  // Switch the live session out of plan mode (as claude_set_mode does).
  sendOptions.permissionMode = "bypassPermissions"
  // Now the same write is no longer plan-blocked — the gate re-read the mode.
  await gate("mcp__cognia-tools__write", { path: "a", content: "b" })
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

test("createToolPermissionGate: no approval channel DENIES a mutating/exec tool (fail-closed)", async () => {
  // Headless / no responder: we cannot obtain consent. A mutating built-in
  // (write/bash/edit) or any plugin/unknown tool must be DENIED, not silently
  // run — the prior fail-open let a local model run shell tools unprompted.
  const gate = createToolPermissionGate({
    emit: undefined, // no channel
    sessionId: "s1",
    pendingApprovals: undefined,
    sendOptions: {}, // default mode, no ruleset/suppress/alwaysAllow
  })
  await assert.rejects(
    gate("mcp__cognia-tools__write", { path: "a", content: "b" }),
    /no approval channel/
  )
  await assert.rejects(
    gate("mcp__cognia-tools__bash", { command: "rm -rf /" }),
    /no approval channel/
  )
  await assert.rejects(gate("mcp__cognia-plugin-tools__anything", {}), /no approval channel/)
  await assert.rejects(gate("some_unknown_tool", {}), /no approval channel/)
})

test("createToolPermissionGate: no approval channel ALLOWS a read-only built-in", async () => {
  // Read-only built-ins can't mutate the host, so a headless context may run
  // them without consent (parity with plan-mode's read-only carve-out).
  const gate = createToolPermissionGate({
    emit: undefined,
    sessionId: "s1",
    pendingApprovals: undefined,
    sendOptions: {},
  })
  assert.deepEqual(await gate("mcp__cognia-tools__git_status", { x: 1 }), { x: 1 })
})

test("createToolPermissionGate: no channel still honours bypass/suppress/alwaysAllow/ruleset", async () => {
  // The explicit opt-in routes must keep working headless: a caller that wants
  // tools in a headless context sets one of these.
  const bypass = createToolPermissionGate({
    emit: undefined,
    sessionId: "s1",
    pendingApprovals: undefined,
    sendOptions: { permissionMode: "bypassPermissions" },
  })
  assert.deepEqual(await bypass("mcp__cognia-tools__bash", { command: "ls" }), { command: "ls" })

  const ruled = createToolPermissionGate({
    emit: undefined,
    sessionId: "s1",
    pendingApprovals: undefined,
    sendOptions: { permissionRuleset: { "*": "allow" } },
  })
  assert.deepEqual(await ruled("mcp__cognia-tools__bash", { command: "ls" }), { command: "ls" })
})

test("allowedTools whitelist: only listed tools are exposed (bare + namespaced match)", () => {
  const tools = buildAiSdkTools({
    sendOptions: {
      builtinTools: { git: true },
      allowedTools: ["git_status", "mcp__cognia-tools__git_diff"],
    },
    emit: () => {},
    sessionId: "s1",
  })
  assert.ok(tools.git_status, "bare allow-name exposes the tool")
  assert.ok(tools.git_diff, "namespaced allow-name exposes the tool")
  assert.equal(tools.git_log, undefined, "an unlisted git tool is filtered out")
})

test("allowedTools whitelist: Claude-Code core names map to cognia coreFiles names", () => {
  const tracker = { record() {}, hasRead: () => false, assertReadBefore() {}, clear() {} }
  const tools = buildAiSdkTools({
    sendOptions: {
      builtinTools: { coreFiles: true },
      cwd: ".",
      // A skill/character restricting to Claude-Code names must scope the
      // equivalent cognia tools on the AI-SDK path, not filter everything out.
      allowedTools: ["Read", "Grep"],
    },
    emit: () => {},
    sessionId: "s1",
    readTracker: tracker,
  })
  assert.ok(tools.read, "Read → read")
  assert.ok(tools.grep, "Grep → grep")
  assert.equal(tools.write, undefined, "Write not in allow list → write filtered")
  assert.equal(tools.bash, undefined, "Bash not in allow list → bash filtered")
})

test("allowedTools whitelist: filters plugin tools by bare and namespaced name", () => {
  const tools = buildAiSdkTools({
    sendOptions: {
      pluginTools: [
        { name: "keep_me", description: "", jsonSchema: { type: "object" }, pluginId: "p" },
        { name: "drop_me", description: "", jsonSchema: { type: "object" }, pluginId: "p" },
      ],
      allowedTools: ["mcp__cognia-plugin-tools__keep_me"],
    },
    emit: () => {},
    sessionId: "s1",
    pendingPluginToolCalls: new Map(),
  })
  assert.ok(tools.keep_me, "listed plugin tool kept")
  assert.equal(tools.drop_me, undefined, "unlisted plugin tool filtered")
})

test("allowedTools whitelist: absent or empty → no filtering (every enabled tool exposed)", () => {
  const tools = buildAiSdkTools({
    sendOptions: { builtinTools: { git: true } }, // no allowedTools
    emit: () => {},
    sessionId: "s1",
  })
  assert.ok(tools.git_status && tools.git_diff && tools.git_log, "all git tools present")
  const empty = buildAiSdkTools({
    sendOptions: { builtinTools: { git: true }, allowedTools: [] },
    emit: () => {},
    sessionId: "s1",
  })
  assert.ok(empty.git_status && empty.git_log, "empty allow list is treated as no restriction")
})

test("allowedTools + disallowedTools: deny still wins over an allow entry", () => {
  const tools = buildAiSdkTools({
    sendOptions: {
      builtinTools: { git: true },
      allowedTools: ["git_status", "git_diff"],
      disallowedTools: ["git_diff"],
    },
    emit: () => {},
    sessionId: "s1",
  })
  assert.ok(tools.git_status, "allowed + not denied → present")
  assert.equal(tools.git_diff, undefined, "allowed but denied → absent (deny wins)")
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

test("runBuiltinHandler bounds a hung read-only tool and rejects on timeout", async () => {
  const { runBuiltinHandler } = __testing__
  // `grep` is a read-only built-in (requiresApproval === false) → gets the net.
  const hung = { name: "grep", handler: () => new Promise(() => {}) }
  await assert.rejects(runBuiltinHandler(hung, {}, 20), /grep.*execution budget/)
})

test("runBuiltinHandler leaves exec tools unbounded (own timeout governs)", async () => {
  const { runBuiltinHandler } = __testing__
  let resolved = false
  // `bash` is NOT read-only → excluded from the net even with a tiny budget,
  // so its handler runs to completion (its own internal timeout governs).
  const slowExec = {
    name: "bash",
    handler: () =>
      new Promise((r) =>
        setTimeout(() => {
          resolved = true
          r("ok")
        }, 30)
      ),
  }
  assert.equal(await runBuiltinHandler(slowExec, {}, 5), "ok")
  assert.equal(resolved, true)
})

test("runBuiltinHandler with a 0 / non-finite budget disables the net", async () => {
  const { runBuiltinHandler } = __testing__
  const def = {
    name: "grep",
    handler: () => new Promise((r) => setTimeout(() => r("late"), 20)),
  }
  assert.equal(await runBuiltinHandler(def, {}, 0), "late")
  assert.equal(await runBuiltinHandler(def, {}, Number.POSITIVE_INFINITY), "late")
})

test("builtinDefToAiSdkTool surfaces a read-only timeout as a thrown execute (→ tool-error)", async () => {
  const { builtinDefToAiSdkTool } = __testing__
  const t = builtinDefToAiSdkTool(
    {
      name: "content_search",
      description: "",
      inputSchema: {},
      handler: () => new Promise(() => {}),
    },
    null,
    15
  )
  await assert.rejects(t.execute({}), /content_search.*execution budget/)
})

test("the default built-in tool budget is the 120s plugin-tool-parity safety net", () => {
  assert.equal(__testing__.DEFAULT_BUILTIN_TOOL_TIMEOUT_MS, 120_000)
})

test("builtinToModelOutput maps a plain string result to a text output", () => {
  const { builtinToModelOutput } = __testing__
  assert.deepEqual(builtinToModelOutput({ output: "hello" }), { type: "text", value: "hello" })
})

test("builtinToModelOutput maps an MCP image block to an image-data content part", () => {
  const { builtinToModelOutput } = __testing__
  const out = builtinToModelOutput({
    output: {
      content: [
        { type: "text", text: "screenshot.png (12 bytes)" },
        { type: "image", data: "QUJD", mimeType: "image/png" },
      ],
    },
  })
  assert.equal(out.type, "content")
  assert.deepEqual(out.value, [
    { type: "text", text: "screenshot.png (12 bytes)" },
    // NOT the deprecated `media` part — the supported `image-data` shape.
    { type: "image-data", mediaType: "image/png", data: "QUJD" },
  ])
})

test("builtinToModelOutput routes non-image media to a file-data part", () => {
  const { builtinToModelOutput } = __testing__
  const out = builtinToModelOutput({
    output: { content: [{ type: "image", data: "QQ==", mimeType: "audio/wav" }] },
  })
  assert.deepEqual(out.value, [{ type: "file-data", mediaType: "audio/wav", data: "QQ==" }])
})

test("hasImageBlock detects an MCP image block and ignores text-only results", () => {
  const { hasImageBlock } = __testing__
  assert.equal(hasImageBlock({ content: [{ type: "image", data: "x" }] }), true)
  assert.equal(hasImageBlock({ content: [{ type: "text", text: "x" }] }), false)
  assert.equal(hasImageBlock("plain"), false)
})
