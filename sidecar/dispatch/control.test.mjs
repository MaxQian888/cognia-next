// Tests for the pure session-control helpers (allowlist, arg mapping, response
// shaping). No I/O — exercises the logic the host's `handleControl` relies on.

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

import {
  CONTROL_METHODS,
  CONTROL_METHOD_CAPABILITIES,
  isControlMethod,
  controlArgs,
  controlMethodCapability,
  controlParamError,
  buildControlResponse,
} from "./control.mjs"

const MANIFEST = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "protocol",
      "agent-control-methods.json"
    ),
    "utf8"
  )
)

test("isControlMethod accepts only allowlisted methods", () => {
  for (const m of CONTROL_METHODS) {
    assert.equal(isControlMethod(m), true, `${m} should be allowed`)
  }
  for (const m of [
    "close",
    "interrupt",
    // Both carry `exposure: "not-exposed"` in the manifest, with a reason.
    "streamInput",
    "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET",
    "__proto__",
    "setModelX",
    "",
    null,
    undefined,
    42,
  ]) {
    assert.equal(isControlMethod(m), false, `${String(m)} should be rejected`)
  }
})

test("the allowlist is exactly what the manifest exposes as a control", () => {
  // The gate proves this too, by reading the source. Asserting it against the
  // LOADED module catches an editing accident the regex would forgive.
  const exposed = MANIFEST.methods.filter((m) => m.exposure === "control").map((m) => m.name)
  assert.deepEqual([...CONTROL_METHODS].sort(), exposed.sort())
  assert.deepEqual(Object.keys(CONTROL_METHOD_CAPABILITIES).sort(), exposed.sort())
})

test("every control has a capability, and it is the manifest's", () => {
  for (const entry of MANIFEST.methods) {
    if (entry.exposure !== "control") continue
    assert.equal(controlMethodCapability(entry.name), entry.capability, entry.name)
  }
  assert.equal(controlMethodCapability("nope"), undefined)
})

test("controlArgs maps params to positional args", () => {
  assert.deepEqual(controlArgs("setModel", { model: "claude-opus-4-8" }), ["claude-opus-4-8"])
  assert.deepEqual(controlArgs("reconnectMcpServer", { serverName: "github" }), ["github"])
  assert.deepEqual(controlArgs("toggleMcpServer", { serverName: "github", enabled: false }), [
    "github",
    false,
  ])
  // No-arg methods ignore params.
  assert.deepEqual(controlArgs("getContextUsage", { junk: 1 }), [])
  assert.deepEqual(controlArgs("mcpServerStatus", undefined), [])
  assert.deepEqual(controlArgs("supportedModels"), [])
  assert.deepEqual(controlArgs("steer", { prompt: "redirect", priority: "now" }), [
    "redirect",
    "now",
  ])
})

test("controlArgs maps every method the manifest gives arguments to", () => {
  // A method allowlisted everywhere but missing a `case` here reaches the SDK
  // with zero arguments — a silent no-op rather than an error.
  for (const entry of MANIFEST.methods) {
    if (entry.exposure !== "control" || entry.args.length === 0) continue
    const params = Object.fromEntries(entry.args.map((name, i) => [name, `v${i}`]))
    assert.deepEqual(
      controlArgs(entry.name, params),
      entry.args.map((_, i) => `v${i}`),
      `${entry.name} must forward [${entry.args.join(", ")}]`
    )
  }
})

test("controlArgs keeps optional trailing args as undefined rather than trimming", () => {
  assert.deepEqual(controlArgs("setModel", undefined), [undefined])
  assert.deepEqual(controlArgs("toggleMcpServer"), [undefined, undefined])
  // `setMaxThinkingTokens(n, display)` is the case that matters: the second
  // parameter distinguishes value / null / omitted, so a trimmed call would
  // mean something different from an omitted one.
  assert.deepEqual(controlArgs("setMaxThinkingTokens", { maxThinkingTokens: 0 }), [0, undefined])
})

// ---- param validation --------------------------------------------------------

test("well-formed params for every control pass validation", () => {
  const ok = {
    setModel: { model: "m" },
    reconnectMcpServer: { serverName: "s" },
    toggleMcpServer: { serverName: "s", enabled: true },
    readFile: { path: "/a" },
    rewindFiles: { userMessageId: "u" },
    seedReadState: { path: "/a", mtime: 1 },
    setMaxThinkingTokens: { maxThinkingTokens: null },
    setMcpPermissionModeOverride: { serverName: "s", mode: null },
    setMcpServers: { servers: { a: { type: "http", url: "https://x" } } },
    stopTask: { taskId: "t" },
    backgroundTasks: {},
    applyFlagSettings: { settings: {} },
  }
  for (const [method, params] of Object.entries(ok)) {
    assert.equal(controlParamError(method, params), null, method)
  }
  // No-arg controls have nothing to validate.
  for (const method of ["accountInfo", "reloadPlugins", "supportedAgents"]) {
    assert.equal(controlParamError(method, undefined), null, method)
  }
})

test("a malformed frame is refused before it reaches the live query", () => {
  const bad = [
    ["setModel", { model: 42 }, "invalid_model"],
    ["reconnectMcpServer", {}, "invalid_server_name"],
    ["toggleMcpServer", { serverName: "s" }, "invalid_enabled"],
    ["readFile", { path: "" }, "invalid_path"],
    ["rewindFiles", {}, "invalid_user_message_id"],
    ["seedReadState", { path: "/a" }, "invalid_mtime"],
    ["seedReadState", { path: "/a", mtime: Number.NaN }, "invalid_mtime"],
    ["setMaxThinkingTokens", { maxThinkingTokens: "lots" }, "invalid_max_thinking_tokens"],
    [
      "setMaxThinkingTokens",
      { maxThinkingTokens: 1, thinkingDisplay: "loud" },
      "invalid_thinking_display",
    ],
    [
      "setMcpPermissionModeOverride",
      { serverName: "s", mode: "bypassPermissions" },
      "invalid_permission_mode",
    ],
    ["setMcpServers", { servers: [] }, "invalid_servers"],
    ["setMcpServers", { servers: { a: null } }, "invalid_servers"],
    ["stopTask", {}, "invalid_task_id"],
    ["backgroundTasks", { toolUseId: 7 }, "invalid_tool_use_id"],
    ["applyFlagSettings", { settings: "on" }, "invalid_settings"],
  ]
  for (const [method, params, code] of bad) {
    assert.equal(controlParamError(method, params), code, `${method} ${JSON.stringify(params)}`)
  }
})

test("setModel accepts an absent model — that means 'back to the default'", () => {
  assert.equal(controlParamError("setModel", {}), null)
})

test("setMcpPermissionModeOverride stays tighten-only", () => {
  // The SDK contract is that this can never widen privilege. Accepting a mode
  // it will refuse anyway just moves the failure further from the caller.
  for (const mode of ["default", "auto", null]) {
    assert.equal(controlParamError("setMcpPermissionModeOverride", { serverName: "s", mode }), null)
  }
  for (const mode of ["acceptEdits", "plan", undefined, ""]) {
    assert.equal(
      controlParamError("setMcpPermissionModeOverride", { serverName: "s", mode }),
      "invalid_permission_mode"
    )
  }
})

test("setMcpServers refuses a transport the SDK cannot register", () => {
  assert.equal(
    controlParamError("setMcpServers", { servers: { a: { type: "carrier-pigeon" } } }),
    "unsupported_mcp_transport"
  )
  // `type` is optional in the SDK config union (stdio is the default), so an
  // omitted one is legal — only an explicitly wrong value is refused.
  assert.equal(controlParamError("setMcpServers", { servers: { a: { command: "x" } } }), null)
  // Emptying the dynamic set is a legitimate request.
  assert.equal(controlParamError("setMcpServers", { servers: {} }), null)
})

test("buildControlResponse shapes a success reply", () => {
  const r = buildControlResponse({
    sessionId: "s1",
    requestId: "r1",
    method: "getContextUsage",
    ok: true,
    result: { percentage: 0.42 },
  })
  assert.deepEqual(r, {
    type: "control_response",
    sessionId: "s1",
    requestId: "r1",
    method: "getContextUsage",
    ok: true,
    result: { percentage: 0.42 },
  })
})

test("buildControlResponse omits result when undefined (e.g. setModel)", () => {
  const r = buildControlResponse({
    sessionId: "s1",
    requestId: "r2",
    method: "setModel",
    ok: true,
  })
  assert.equal("result" in r, false)
  assert.equal(r.ok, true)
})

test("buildControlResponse shapes a failure reply with a default code", () => {
  const r = buildControlResponse({
    sessionId: "s1",
    requestId: "r3",
    method: "mcpServerStatus",
    ok: false,
  })
  assert.equal(r.ok, false)
  assert.equal(r.error, "error")
  assert.equal("result" in r, false)
})

test("buildControlResponse preserves an explicit error code", () => {
  const r = buildControlResponse({
    sessionId: "s1",
    requestId: "r4",
    method: "setModel",
    ok: false,
    error: "unsupported_provider",
  })
  assert.equal(r.error, "unsupported_provider")
})
