// Tests for the AI SDK tool bridge: converts built-in tool defs + plugin tool
// manifests into native AI SDK tools for the non-Anthropic dispatch path.

import { test } from "node:test"
import assert from "node:assert/strict"
import { buildAiSdkTools, __testing__ } from "./ai-sdk-tools.mjs"
import { createSessionTaskStore } from "../src/tools/state/tasks.ts"

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

test("buildAiSdkTools exposes no tools when the runtime tool surface is disabled", () => {
  const tools = buildAiSdkTools({
    sendOptions: {
      toolSurface: "none",
      builtinTools: { git: true },
      pluginTools: [
        { name: "web_search", description: "", jsonSchema: { type: "object" }, pluginId: "p" },
      ],
    },
    emit: () => {},
    sessionId: "support-session",
    pendingPluginToolCalls: new Map(),
  })
  assert.deepEqual(tools, {})
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
      turnId: "turn-1",
      execution: { identity: { attemptId: "attempt-2" } },
      sandboxRuntimeRef: "sandbox-runtime:ai-sdk",
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
  assert.equal(event.sandboxRuntimeRef, "sandbox-runtime:ai-sdk")
  assert.equal(event.turnId, "turn-1")
  assert.equal(event.attemptId, "attempt-2")
  assert.equal(pendingPluginToolCalls.size, 1)

  // Resolve the round-trip the way claude-host's plugin_tool_response would.
  const pending = pendingPluginToolCalls.get(event.toolUseId)
  pending.resolve({ result: "plugin says hi" })
  const result = await execPromise
  assert.equal(result, "plugin says hi")
})

test("AI SDK plugin tools honor the manifest timeout instead of the 120s default", async () => {
  const pendingPluginToolCalls = new Map()
  const tools = buildAiSdkTools({
    sendOptions: {
      permissionMode: "bypassPermissions",
      pluginTools: [
        {
          name: "short_deadline",
          description: "test timeout propagation",
          jsonSchema: { type: "object", properties: {} },
          pluginId: "test",
          timeoutMs: 5,
        },
      ],
    },
    emit: () => {},
    sessionId: "s-timeout",
    pendingPluginToolCalls,
  })

  const outcome = await Promise.race([
    tools.short_deadline.execute({}).then(
      (value) => ({ value }),
      (error) => ({ error })
    ),
    new Promise((resolve) => setTimeout(() => resolve({ stalled: true }), 40)),
  ])

  assert.equal("stalled" in outcome, false, "manifest timeout was ignored")
  assert.match(String(outcome.error), /timed out after 5ms/)
  assert.equal(pendingPluginToolCalls.size, 0)
})

test("plugin tool image results pass through as content blocks the model can see", async () => {
  const pendingPluginToolCalls = new Map()
  const tools = buildAiSdkTools({
    sendOptions: {
      permissionMode: "bypassPermissions",
      pluginTools: [
        { name: "take_screenshot", description: "", jsonSchema: { type: "object" }, pluginId: "p" },
      ],
    },
    emit: () => {},
    sessionId: "s1",
    pendingPluginToolCalls,
  })
  const execPromise = tools.take_screenshot.execute({})
  await Promise.resolve()
  const [, pending] = [...pendingPluginToolCalls.entries()][0]
  const callToolResult = {
    content: [
      { type: "text", text: "shot.png (12 bytes)" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ],
  }
  pending.resolve({ result: callToolResult })
  // Not JSON.stringify-ed: the raw MCP object survives for toModelOutput.
  assert.deepEqual(await execPromise, callToolResult)

  // …and toModelOutput maps it to a multimodal part, not a base64 string.
  const modelOutput = tools.take_screenshot.toModelOutput({ output: callToolResult })
  assert.equal(modelOutput.type, "content")
  assert.deepEqual(modelOutput.value, [
    { type: "text", text: "shot.png (12 bytes)" },
    { type: "file", mediaType: "image/png", data: { type: "data", data: "AAAA" } },
  ])
})

test("plugin tool audio-only results pass through as file content the model can see", async () => {
  const pendingPluginToolCalls = new Map()
  const tools = buildAiSdkTools({
    sendOptions: {
      permissionMode: "bypassPermissions",
      pluginTools: [
        { name: "record_audio", description: "", jsonSchema: { type: "object" }, pluginId: "p" },
      ],
    },
    emit: () => {},
    sessionId: "s1",
    pendingPluginToolCalls,
  })
  const execPromise = tools.record_audio.execute({})
  await Promise.resolve()
  const [, pending] = [...pendingPluginToolCalls.entries()][0]
  const callToolResult = {
    content: [{ type: "audio", data: "UklGRg==", mimeType: "audio/wav" }],
  }
  pending.resolve({ result: callToolResult })

  assert.deepEqual(await execPromise, callToolResult)
  assert.deepEqual(tools.record_audio.toModelOutput({ output: callToolResult }), {
    type: "content",
    value: [{ type: "file", mediaType: "audio/wav", data: { type: "data", data: "UklGRg==" } }],
  })
})

test("plugin tool resource-only results pass through with embedded text and blob content", async () => {
  const pendingPluginToolCalls = new Map()
  const tools = buildAiSdkTools({
    sendOptions: {
      permissionMode: "bypassPermissions",
      pluginTools: [
        { name: "read_resource", description: "", jsonSchema: { type: "object" }, pluginId: "p" },
      ],
    },
    emit: () => {},
    sessionId: "s1",
    pendingPluginToolCalls,
  })
  const execPromise = tools.read_resource.execute({})
  await Promise.resolve()
  const [, pending] = [...pendingPluginToolCalls.entries()][0]
  const callToolResult = {
    content: [
      {
        type: "resource",
        resource: { uri: "file:///repo/notes.txt", text: "resource text", mimeType: "text/plain" },
      },
      {
        type: "resource",
        resource: {
          uri: "file:///repo/clip.wav",
          name: "clip.wav",
          blob: "UklGRg==",
          mimeType: "audio/wav",
        },
      },
    ],
  }
  pending.resolve({ result: callToolResult })

  assert.deepEqual(await execPromise, callToolResult)
  assert.deepEqual(tools.read_resource.toModelOutput({ output: callToolResult }), {
    type: "content",
    value: [
      { type: "text", text: "resource text" },
      {
        type: "file",
        mediaType: "audio/wav",
        data: { type: "data", data: "UklGRg==" },
        filename: "clip.wav",
      },
    ],
  })
})

test("plugin rich results are redacted before model output when they contain PII", async () => {
  const pendingPluginToolCalls = new Map()
  const tools = buildAiSdkTools({
    sendOptions: {
      permissionMode: "bypassPermissions",
      pluginTools: [
        { name: "read_resource", description: "", jsonSchema: { type: "object" }, pluginId: "p" },
      ],
    },
    emit: () => {},
    sessionId: "s1",
    pendingPluginToolCalls,
  })
  const execPromise = tools.read_resource.execute({})
  await Promise.resolve()
  const [, pending] = [...pendingPluginToolCalls.entries()][0]
  pending.resolve({
    result: {
      content: [
        {
          type: "resource",
          resource: {
            uri: "file:///repo/contacts.txt",
            text: "Contact alice@example.com",
            mimeType: "text/plain",
          },
        },
      ],
    },
  })

  const result = await execPromise
  assert.equal(result.content[0].resource.text, "Contact <EMAIL_001>")
  assert.doesNotMatch(JSON.stringify(result), /alice@example\.com/)
})

test("textual resource blobs are decoded and redacted before model output", async () => {
  const pendingPluginToolCalls = new Map()
  const tools = buildAiSdkTools({
    sendOptions: {
      permissionMode: "bypassPermissions",
      pluginTools: [
        { name: "read_resource", description: "", jsonSchema: { type: "object" }, pluginId: "p" },
      ],
    },
    emit: () => {},
    sessionId: "s1",
    pendingPluginToolCalls,
  })
  const execPromise = tools.read_resource.execute({})
  await Promise.resolve()
  const [, pending] = [...pendingPluginToolCalls.entries()][0]
  pending.resolve({
    result: {
      content: [
        {
          type: "resource",
          resource: {
            uri: "file:///repo/contacts.txt",
            blob: Buffer.from("Contact alice@example.com").toString("base64"),
            mimeType: "text/plain; charset=utf-8",
          },
        },
      ],
    },
  })

  const result = await execPromise
  const decoded = Buffer.from(result.content[0].resource.blob, "base64").toString("utf8")
  assert.equal(decoded, "Contact <EMAIL_001>")
  assert.doesNotMatch(decoded, /alice@example\.com/)
})

test("plugin tool results with no image still flatten to JSON text", async () => {
  const pendingPluginToolCalls = new Map()
  const tools = buildAiSdkTools({
    sendOptions: {
      permissionMode: "bypassPermissions",
      pluginTools: [
        { name: "plain", description: "", jsonSchema: { type: "object" }, pluginId: "p" },
      ],
    },
    emit: () => {},
    sessionId: "s1",
    pendingPluginToolCalls,
  })
  const execPromise = tools.plain.execute({})
  await Promise.resolve()
  const [, pending] = [...pendingPluginToolCalls.entries()][0]
  pending.resolve({ result: { ok: true, count: 2 } })
  assert.equal(await execPromise, '{"ok":true,"count":2}')
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

test("plugin tool errors are redacted before they reach the model", async () => {
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
  pending.resolve({ error: "Contact alice@example.com" })

  await assert.rejects(execPromise, (error) => {
    assert.match(error.message, /Contact <EMAIL_001>/)
    assert.doesNotMatch(error.message, /alice@example\.com/)
    return true
  })
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

test("buildAiSdkTools threads a caller-provided doomGuard into the gate (so the session can reset it per turn)", async () => {
  // F1: the ai-sdk tools map is built once and reused across turns, so the
  // session owns the doom-loop guard and resets it per turn. This verifies the
  // provided guard is the one the gate actually consults (the reset hook is
  // pointless if buildAiSdkTools silently makes its own).
  const checked = []
  const spyGuard = {
    check: (name, input) => {
      checked.push({ name, input })
      return null // no doom — let the call proceed
    },
    reset: () => {},
  }
  const tools = buildAiSdkTools({
    sendOptions: {
      builtinTools: { git: true },
      permissionRuleset: { "*": "allow" },
    },
    emit: () => {},
    sessionId: "s1",
    pendingApprovals: new Map(),
    doomGuard: spyGuard,
  })
  try {
    await tools.git_status.execute({ cwd: "/tmp" })
  } catch {
    // The handler may fail to shell out in CI; the doom guard is consulted
    // by the gate BEFORE execution, which is all this test asserts.
  }
  assert.ok(
    checked.some((c) => c.name === "mcp__cognia-tools__git_status"),
    "the caller-provided doomGuard was consulted for the gated call"
  )
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
    "TaskCreate",
    "TaskGet",
    "TaskList",
    "TaskUpdate",
    "list_shells",
    "Monitor",
    "monitor_cancel",
    "monitor_list",
  ]) {
    assert.ok(tools[name], `${name} registered`)
  }
})

test("AI-SDK monitor tools reach host_rpc with the active session owner", async () => {
  const calls = []
  const tools = buildAiSdkTools({
    sendOptions: { builtinTools: { coreFiles: true }, cwd: "." },
    emit: () => {},
    sessionId: "session-monitor",
    hostRpc: {
      async call(method, params) {
        calls.push({ method, params })
        return { monitors: [{ id: "monitor-1", status: "waiting" }] }
      },
    },
  })

  const result = JSON.parse(await tools.monitor_list.execute({}))

  assert.deepEqual(result.monitors, [{ id: "monitor-1", status: "waiting" }])
  assert.deepEqual(calls, [
    {
      method: "monitors.list",
      params: { owner: { kind: "session", sessionId: "session-monitor" } },
    },
  ])
})

test("structured tasks persist when the ai-sdk tool map is rebuilt between turns", async () => {
  const taskStore = createSessionTaskStore()
  const shared = {
    sendOptions: { builtinTools: { coreFiles: true }, cwd: "." },
    emit: () => {},
    sessionId: "s1",
    readTracker: { record() {}, hasRead: () => false, assertReadBefore() {}, clear() {} },
    taskStore,
  }
  const firstTurn = buildAiSdkTools(shared)
  const created = JSON.parse(
    await firstTurn.TaskCreate.execute({ subject: "Research", description: "Map gaps" })
  )
  assert.equal(created.task.id, "1")

  const secondTurn = buildAiSdkTools(shared)
  const listed = JSON.parse(await secondTurn.TaskList.execute({}))
  assert.deepEqual(
    listed.tasks.map((task) => task.subject),
    ["Research"]
  )
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
  const { builtinDefToAiSdkTool } = __testing__
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

test("execute-layer review rewrites the output the MODEL receives", async () => {
  const def = {
    name: "echo_x",
    description: "",
    inputSchema: {},
    handler: async () => ({ content: [{ type: "text", text: "original" }] }),
  }
  const review = async (toolName, _toolCallId, output, isError) => {
    assert.equal(toolName, "mcp__cognia-tools__echo_x")
    assert.equal(output, "original")
    assert.equal(isError, false)
    return "REWRITTEN"
  }
  const t = __testing__.builtinDefToAiSdkTool(def, null, 0, review)
  const out = await t.execute({}, { toolCallId: "tc1" })
  assert.equal(out, "REWRITTEN")
})

test("execute-layer review can rewrite an error message; undefined passes through", async () => {
  const failing = {
    name: "boom",
    description: "",
    inputSchema: {},
    handler: async () => ({ isError: true, content: [{ type: "text", text: "raw failure" }] }),
  }
  const t1 = __testing__.builtinDefToAiSdkTool(failing, null, 0, async () => "cleaned failure")
  await assert.rejects(() => t1.execute({}, {}), /cleaned failure/)
  const ok = {
    name: "fine",
    description: "",
    inputSchema: {},
    handler: async () => ({ content: [{ type: "text", text: "kept" }] }),
  }
  const t2 = __testing__.builtinDefToAiSdkTool(ok, null, 0, async () => undefined)
  assert.equal(await t2.execute({}, {}), "kept")
})

test("built-in thrown and isError failures are redacted before they reach the model", async () => {
  const thrown = {
    name: "thrown_pii",
    description: "",
    inputSchema: {},
    handler: async () => {
      throw new Error("Contact alice@example.com")
    },
  }
  const errorResult = {
    name: "result_pii",
    description: "",
    inputSchema: {},
    handler: async () => ({
      isError: true,
      content: [{ type: "text", text: "Contact bob@example.com" }],
    }),
  }

  for (const definition of [thrown, errorResult]) {
    const subject = __testing__.builtinDefToAiSdkTool(definition, null, 0)
    await assert.rejects(
      () => subject.execute({}, {}),
      (error) => {
        assert.match(error.message, /Contact <EMAIL_001>/)
        assert.doesNotMatch(error.message, /@(example\.com)/)
        return true
      }
    )
  }
})

test("JSON-string tool results remain valid while nested PII is redacted", async () => {
  const definition = {
    name: "json_pii",
    description: "",
    inputSchema: {},
    handler: async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({ createdAt: 1_754_000_000_000, contact: "alice@example.com" }),
        },
      ],
    }),
  }
  const subject = __testing__.builtinDefToAiSdkTool(definition, null, 0)

  const output = await subject.execute({}, {})

  assert.deepEqual(JSON.parse(output), {
    createdAt: 1_754_000_000_000,
    contact: "<EMAIL_001>",
  })
})

test("a throwing reviewer fails open (original output preserved)", async () => {
  assert.equal(
    await __testing__.applyOutputReview(
      async () => {
        throw new Error("reviewer broke")
      },
      "mcp__cognia-tools__x",
      "id",
      "original",
      false
    ),
    "original"
  )
})
