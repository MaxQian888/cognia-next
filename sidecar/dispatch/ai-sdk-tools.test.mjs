// Tests for the AI SDK tool bridge: converts built-in tool defs + plugin tool
// manifests into native AI SDK tools for the non-Anthropic dispatch path.

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { buildAiSdkTools, createToolPermissionGate, __testing__ } from "./ai-sdk-tools.mjs"
import { createSessionTaskStore } from "../builtin-tools/core/tasks.mjs"

function mkConfRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cognia-gate-conf-"))
}

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

test("resource links remain visible text without authorizing provider-side fetches", () => {
  const output = __testing__.builtinToModelOutput({
    output: {
      content: [
        {
          type: "resource_link",
          uri: "https://example.test/manual.pdf",
          name: "Manual",
        },
      ],
    },
  })

  assert.deepEqual(output, {
    type: "content",
    value: [{ type: "text", text: "Manual: https://example.test/manual.pdf" }],
  })
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

test("createToolPermissionGate: plan mode allows subagent dispatch + load_skill plugin tools", async () => {
  const gate = createToolPermissionGate({
    emit: () => {},
    sessionId: "s1",
    pendingApprovals: new Map(),
    sendOptions: { permissionMode: "plan" },
  })
  // Plan mode instructs the model to dispatch the read-only Explore/Plan
  // subagents; the dispatch tools live on the plugin-tools server, so they must
  // be allowlisted here or the explore→plan flow breaks off-Anthropic. The
  // dispatched child inherits permissionMode:"plan", so read-only is preserved.
  await gate("mcp__cognia-plugin-tools__dispatch_agent", {
    subagentId: "Explore",
    prompt: "survey",
  })
  await gate("mcp__cognia-plugin-tools__Task", { subagentId: "Plan", prompt: "design" })
  await gate("mcp__cognia-plugin-tools__load_skill", { name: "some-skill" })
  await gate("mcp__cognia-plugin-tools__load_skill_resource", {
    skill_id: "some-skill",
    path: "references/rubric.md",
  })
  // A mutating plugin tool stays denied even though dispatch is now permitted.
  await assert.rejects(gate("mcp__cognia-plugin-tools__file_write", {}), /plan mode/)
})

test("createToolPermissionGate: acceptEdits auto-approves file-edit tools, still prompts for exec", async () => {
  let emitted = 0
  const pending = new Map()
  const gate = createToolPermissionGate({
    emit: (ev) => {
      emitted++
      queueMicrotask(() => pending.get(ev.requestId)?.resolve({ behavior: "deny", message: "no" }))
    },
    sessionId: "s1",
    pendingApprovals: pending,
    sendOptions: { permissionMode: "acceptEdits" },
  })
  // Edit-class built-ins run without a permission_request (parity with the
  // Anthropic SDK's acceptEdits).
  await gate("mcp__cognia-tools__write", { path: "a", content: "x" })
  await gate("mcp__cognia-tools__edit", {})
  await gate("mcp__cognia-tools__multi_edit", {})
  assert.equal(emitted, 0, "edit-class tools must not prompt in acceptEdits")
  // Exec/process tools are NOT edit-class → still gated (here denied by the stub).
  await assert.rejects(gate("mcp__cognia-tools__bash", { command: "ls" }))
  assert.ok(emitted >= 1, "a non-edit tool must still round-trip through approval")
})

test("createToolPermissionGate: confinement escalates an out-of-root write past acceptEdits", async () => {
  const root = mkConfRoot()
  const outside = path.join(mkConfRoot(), "escape.txt")
  let emitted = 0
  const pending = new Map()
  const gate = createToolPermissionGate({
    emit: (ev) => {
      emitted++
      queueMicrotask(() => pending.get(ev.requestId)?.resolve({ behavior: "deny", message: "no" }))
    },
    sessionId: "s1",
    pendingApprovals: pending,
    sendOptions: {
      permissionMode: "acceptEdits",
      cwd: root,
      confinement: { enabled: true, roots: [root] },
    },
  })
  // In-root write → acceptEdits auto-approves, no prompt.
  await gate("mcp__cognia-tools__write", { file_path: path.join(root, "a.txt"), content: "x" })
  assert.equal(emitted, 0, "in-root edit must not prompt in acceptEdits")
  // Out-of-root write → confinement "ask" overrides acceptEdits → round-trips.
  await assert.rejects(gate("mcp__cognia-tools__write", { file_path: outside, content: "x" }))
  assert.ok(emitted >= 1, "an out-of-root write must escalate to approval")
})

test("createToolPermissionGate: confinement overrides a ruleset allow for out-of-root writes", async () => {
  const root = mkConfRoot()
  const outside = path.join(mkConfRoot(), "escape.txt")
  let emitted = 0
  const pending = new Map()
  const gate = createToolPermissionGate({
    emit: (ev) => {
      emitted++
      queueMicrotask(() => pending.get(ev.requestId)?.resolve({ behavior: "deny", message: "no" }))
    },
    sessionId: "s1",
    pendingApprovals: pending,
    sendOptions: {
      permissionMode: "default",
      cwd: root,
      permissionRuleset: { "mcp__cognia-tools__write": "allow" },
      confinement: { enabled: true, roots: [root] },
    },
  })
  // In-root: allow rule stands → runs silently.
  await gate("mcp__cognia-tools__write", { file_path: path.join(root, "a.txt"), content: "x" })
  assert.equal(emitted, 0)
  // Out-of-root: confinement "ask" beats the allow rule → round-trips.
  await assert.rejects(gate("mcp__cognia-tools__write", { file_path: outside, content: "x" }))
  assert.ok(emitted >= 1)
})

test("createToolPermissionGate: confinement hard-denies a credential-path write in every mode", async () => {
  const root = mkConfRoot()
  const secret = path.join(os.homedir(), ".ssh", "authorized_keys")
  for (const permissionMode of ["default", "acceptEdits", "bypassPermissions", "dontAsk"]) {
    const gate = createToolPermissionGate({
      emit: () => {},
      sessionId: "s1",
      pendingApprovals: new Map(),
      sendOptions: {
        permissionMode,
        cwd: root,
        confinement: { enabled: true, roots: [root] },
      },
    })
    await assert.rejects(
      gate("mcp__cognia-tools__write", { file_path: secret, content: "x" }),
      /protected credential path/,
      `credential write must be denied in ${permissionMode}`
    )
  }
})

test("createToolPermissionGate: dontAsk allows read-only builtins, denies the rest without prompting", async () => {
  const events = []
  const gate = createToolPermissionGate({
    emit: (m) => events.push(m),
    sessionId: "s1",
    pendingApprovals: new Map(),
    sendOptions: { permissionMode: "dontAsk" },
  })
  // Read-only built-in → allowed silently.
  await gate("mcp__cognia-tools__git_status", {})
  // Mutating built-in and plugin tool → denied WITHOUT a permission_request.
  await assert.rejects(gate("mcp__cognia-tools__bash", { command: "ls" }), /dontAsk mode/)
  await assert.rejects(gate("mcp__cognia-plugin-tools__file_write", {}), /dontAsk mode/)
  assert.equal(
    events.some((e) => e.type === "permission_request"),
    false,
    "dontAsk must never emit a permission_request"
  )
})

test("createToolPermissionGate: dontAsk honours ruleset allow but denies (not prompts) on no verdict", async () => {
  const events = []
  const gate = createToolPermissionGate({
    emit: (m) => events.push(m),
    sessionId: "s1",
    pendingApprovals: new Map(),
    sendOptions: {
      permissionMode: "dontAsk",
      permissionRuleset: { "mcp__cognia-tools__write": "allow" },
    },
  })
  // Pre-approved by an allow rule → runs.
  await gate("mcp__cognia-tools__write", { path: "a", content: "x" })
  // No verdict for bash → denied without prompting (default mode would prompt here).
  await assert.rejects(gate("mcp__cognia-tools__bash", { command: "ls" }), /dontAsk mode/)
  assert.equal(events.length, 0, "no permission_request in dontAsk")
})

test("createToolPermissionGate: dontAsk honours suppress/alwaysAllow entries and ask_user", async () => {
  const gate = createToolPermissionGate({
    emit: () => {},
    sessionId: "s1",
    pendingApprovals: new Map(),
    sendOptions: {
      permissionMode: "dontAsk",
      suppressApprovalForTools: ["mcp__cognia-tools__edit"],
      alwaysAllowTools: ["mcp__cognia-plugin-tools__web_search"],
    },
  })
  await gate("mcp__cognia-tools__edit", {})
  await gate("mcp__cognia-plugin-tools__web_search", { q: "x" })
  // ask_user is the user interaction itself — allowed in every mode.
  await gate("mcp__cognia-plugin-tools__ask_user", { question: "?" })
  await assert.rejects(gate("mcp__cognia-tools__multi_edit", {}), /dontAsk mode/)
})

test("createToolPermissionGate: dontAsk denies a doomed repeat even for a read-only tool", async () => {
  // We cannot round-trip through the user in dontAsk, so a doomed (Nth
  // identical) call is denied outright rather than silently allowed.
  const gate = createToolPermissionGate({
    emit: () => {},
    sessionId: "s1",
    pendingApprovals: new Map(),
    sendOptions: { permissionMode: "dontAsk" },
    doomGuard: { check: () => "ask" },
  })
  await assert.rejects(gate("mcp__cognia-tools__git_status", {}), /dontAsk mode/)
})

test("createToolPermissionGate: live set_mode into dontAsk takes effect on the next call", async () => {
  const sendOptions = { permissionMode: "bypassPermissions" }
  const events = []
  const gate = createToolPermissionGate({
    emit: (m) => events.push(m),
    sessionId: "s1",
    pendingApprovals: new Map(),
    sendOptions,
  })
  // bypass: write allowed.
  await gate("mcp__cognia-tools__write", { path: "a", content: "b" })
  // Switch the live session to dontAsk (as claude_set_mode does).
  sendOptions.permissionMode = "dontAsk"
  await assert.rejects(
    gate("mcp__cognia-tools__write", { path: "a", content: "b" }),
    /dontAsk mode/
  )
  assert.equal(events.length, 0)
})

test("createToolPermissionGate: auto mode emits a permission_request (renderer Layer-B answers it)", async () => {
  // Regression: "auto" must neither silently allow nor deny in the gate — the
  // round-trip is how the renderer's auto-mode runner gets to classify the call.
  const events = []
  const pendingApprovals = new Map()
  const gate = createToolPermissionGate({
    emit: (m) => {
      events.push(m)
      queueMicrotask(() => pendingApprovals.get(m.requestId)?.resolve({ behavior: "allow" }))
    },
    sessionId: "s1",
    pendingApprovals,
    sendOptions: { permissionMode: "auto" },
  })
  await gate("mcp__cognia-tools__bash", { command: "ls" })
  assert.equal(events.filter((e) => e.type === "permission_request").length, 1)
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

test("builtinToModelOutput maps an MCP image block to a canonical file content part", () => {
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
    // AI SDK 7 canonical shape: one `file` part with a tagged data union.
    // The `media` and `image-data` variants are both gone.
    { type: "file", mediaType: "image/png", data: { type: "data", data: "QUJD" } },
  ])
})

test("builtinToModelOutput routes non-image media to a canonical file part", () => {
  const { builtinToModelOutput } = __testing__
  const out = builtinToModelOutput({
    output: { content: [{ type: "image", data: "QQ==", mimeType: "audio/wav" }] },
  })
  assert.deepEqual(out.value, [
    { type: "file", mediaType: "audio/wav", data: { type: "data", data: "QQ==" } },
  ])
})

test("hasImageBlock detects an MCP image block and ignores text-only results", () => {
  const { hasImageBlock } = __testing__
  assert.equal(hasImageBlock({ content: [{ type: "image", data: "x" }] }), true)
  assert.equal(hasImageBlock({ content: [{ type: "text", text: "x" }] }), false)
  assert.equal(hasImageBlock("plain"), false)
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

test("gate settles a pending approval as denied when the step aborts", async () => {
  const pendingApprovals = new Map()
  const emitted = []
  const gate = createToolPermissionGate({
    emit: (m) => emitted.push(m),
    sessionId: "s",
    pendingApprovals,
    sendOptions: {},
  })
  const ac = new AbortController()
  const p = gate("mcp__cognia-tools__bash", { command: "ls" }, ac.signal)
  // The request round-tripped; nothing answers — abort must settle it.
  await new Promise((r) => setImmediate(r))
  assert.equal(pendingApprovals.size, 1)
  ac.abort()
  await assert.rejects(() => p, /aborted/)
  assert.equal(pendingApprovals.size, 0)
})
