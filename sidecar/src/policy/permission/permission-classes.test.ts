import { test } from "node:test"
import assert from "node:assert/strict"

import {
  EMPTY_PLUGIN_CLASS_INDEX,
  buildPluginClassIndex,
  classesOfTool,
  explicitToolAllowedFrame,
  explicitToolMustAsk,
  explicitToolName,
  explicitToolObserved,
  isExplicitTool,
  isSandboxExecuted,
  profileDenialMessage,
  profileVerdict,
  readApprovalTtlMs,
  readExplicitToolPolicy,
  readPermissionProfile,
  readSandboxAttested,
  requestPermissionClass,
} from "./permission-classes.ts"

const PROFILE = {
  workspace: "sandbox",
  outbound: "ask",
  secrets: "ask",
  hostConfig: "ask",
} as const

const INDEX = buildPluginClassIndex([
  { name: "im_send", pluginId: "acme", permissionClasses: ["outbound"] },
  { name: "vault_read", pluginId: "acme", permissionClasses: ["secrets", "bogus"] },
  { name: "sandbox_bash", pluginId: "cognia-sandboxed-tools" },
  // Same name from another plugin: not the first-party sandbox.
  { name: "sandbox_write", pluginId: "impostor" },
  { name: "notes", pluginId: "acme" },
])

test("built-in tools that need approval are workspace; read-only ones are in no class", () => {
  assert.deepEqual(classesOfTool("mcp__cognia-tools__write", EMPTY_PLUGIN_CLASS_INDEX), [
    "workspace",
  ])
  assert.deepEqual(classesOfTool("mcp__cognia-tools__bash", EMPTY_PLUGIN_CLASS_INDEX), [
    "workspace",
  ])
  assert.deepEqual(classesOfTool("mcp__cognia-tools__read", EMPTY_PLUGIN_CLASS_INDEX), [])
})

test("the Agent SDK's own editors and shell are workspace", () => {
  for (const name of ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"]) {
    assert.deepEqual(classesOfTool(name, EMPTY_PLUGIN_CLASS_INDEX), ["workspace"], name)
  }
  assert.deepEqual(classesOfTool("Read", EMPTY_PLUGIN_CLASS_INDEX), [])
})

test("plugin tools carry the host's classes; unknown classes are dropped", () => {
  assert.deepEqual(classesOfTool("mcp__cognia-plugin-tools__im_send", INDEX), ["outbound"])
  assert.deepEqual(classesOfTool("mcp__cognia-plugin-tools__vault_read", INDEX), ["secrets"])
  assert.deepEqual(classesOfTool("mcp__cognia-plugin-tools__notes", INDEX), [])
  // A user's own MCP server: nothing is known about it.
  assert.deepEqual(classesOfTool("mcp__github__create_issue", INDEX), [])
})

test("only the first-party sandboxed tools count as sandbox-executed", () => {
  assert.equal(isSandboxExecuted("mcp__cognia-plugin-tools__sandbox_bash", INDEX), true)
  assert.deepEqual(classesOfTool("mcp__cognia-plugin-tools__sandbox_bash", INDEX), ["workspace"])
  assert.equal(isSandboxExecuted("mcp__cognia-plugin-tools__sandbox_write", INDEX), false)
  assert.equal(isSandboxExecuted("mcp__cognia-tools__bash", INDEX), false)
})

test("no profile means no verdict", () => {
  assert.deepEqual(profileVerdict(undefined, "mcp__cognia-plugin-tools__im_send", INDEX), {
    kind: "none",
  })
})

test("outbound, secret and host-configuration classes always ask at their ceiling", () => {
  assert.deepEqual(profileVerdict(PROFILE, "mcp__cognia-plugin-tools__im_send", INDEX), {
    kind: "always-ask",
    cls: "outbound",
  })
  assert.deepEqual(profileVerdict(PROFILE, "mcp__cognia-plugin-tools__vault_read", INDEX), {
    kind: "always-ask",
    cls: "secrets",
  })
  // Workspace never always-asks: its `ask` and `sandbox` leave the ladder in charge.
  assert.deepEqual(profileVerdict(PROFILE, "mcp__cognia-tools__write", INDEX), { kind: "none" })
  assert.deepEqual(
    profileVerdict({ ...PROFILE, workspace: "ask" }, "mcp__cognia-tools__write", INDEX),
    { kind: "none" }
  )
})

test("a deny in any of the call's classes wins", () => {
  assert.deepEqual(
    profileVerdict({ ...PROFILE, outbound: "deny" }, "mcp__cognia-plugin-tools__im_send", INDEX),
    { kind: "deny", cls: "outbound" }
  )
  assert.deepEqual(profileVerdict({ ...PROFILE, workspace: "deny" }, "Bash", INDEX), {
    kind: "deny",
    cls: "workspace",
  })
  const both = buildPluginClassIndex([
    { name: "deploy", pluginId: "p", permissionClasses: ["outbound", "hostConfig"] },
  ])
  assert.deepEqual(
    profileVerdict({ ...PROFILE, hostConfig: "deny" }, "mcp__cognia-plugin-tools__deploy", both),
    { kind: "deny", cls: "hostConfig" }
  )
})

test("the denial tells the model what was refused and not to retry", () => {
  const message = profileDenialMessage("im_send", "outbound")
  assert.match(message, /outbound messages/)
  assert.match(message, /Do not retry/)
})

test("reads the profile, failing a malformed class closed to ask", () => {
  assert.equal(readPermissionProfile(undefined), null)
  assert.deepEqual(readPermissionProfile(PROFILE), PROFILE)
  assert.deepEqual(readPermissionProfile({ workspace: "allow", outbound: "deny" }), {
    workspace: "ask",
    outbound: "deny",
    secrets: "ask",
    hostConfig: "ask",
  })
  assert.deepEqual(readPermissionProfile("yes"), {
    workspace: "ask",
    outbound: "ask",
    secrets: "ask",
    hostConfig: "ask",
  })
})

test("only a schema-1 microvm or container attestation counts", () => {
  assert.equal(readSandboxAttested({ schemaVersion: 1, tier: "microvm", verifiedAt: 1 }), true)
  // An always-on Host's runtime environment container (ADR-0224 A8).
  assert.equal(readSandboxAttested({ schemaVersion: 1, tier: "container", verifiedAt: 1 }), true)
  assert.equal(readSandboxAttested({ schemaVersion: 1, tier: "os" }), false)
  assert.equal(readSandboxAttested({ schemaVersion: 1, tier: "cua-desktop" }), false)
  assert.equal(readSandboxAttested({ schemaVersion: 2, tier: "microvm" }), false)
  assert.equal(readSandboxAttested(null), false)
})

test("reads a positive approval TTL and ignores anything else", () => {
  assert.equal(readApprovalTtlMs(1500.7), 1500)
  assert.equal(readApprovalTtlMs(0), undefined)
  assert.equal(readApprovalTtlMs("60000"), undefined)
  assert.equal(readApprovalTtlMs(undefined), undefined)
})

test("an always-explicit list matches the registered name on any server", () => {
  const policy = readExplicitToolPolicy([" Send_Email ", "im_broadcast", 7, ""], "observe")
  assert.deepEqual(policy && [...policy.tools].sort(), ["im_broadcast", "send_email"])
  assert.equal(explicitToolName("mcp__cognia-tools__Send_Email"), "send_email")
  assert.equal(isExplicitTool("mcp__cognia-tools__send_email", policy), true)
  assert.equal(isExplicitTool("mcp__someone__send_email", policy), true)
  assert.equal(isExplicitTool("mcp__cognia-plugin-tools__im_broadcast", policy), true)
  assert.equal(isExplicitTool("mcp__cognia-tools__write", policy), false)
  assert.equal(isExplicitTool("send_email", null), false)
})

test("an always-explicit list enforces unless its mode is exactly observe", () => {
  assert.equal(readExplicitToolPolicy(undefined, "enforce"), null)
  assert.equal(readExplicitToolPolicy([], "enforce"), null)
  assert.equal(readExplicitToolPolicy("send_email", "enforce"), null)
  for (const mode of [undefined, "enforce", "Observe", "shadow", 1]) {
    assert.equal(readExplicitToolPolicy(["send_email"], mode)?.mode, "enforce", String(mode))
  }
  const observe = readExplicitToolPolicy(["send_email"], "observe")
  const enforce = readExplicitToolPolicy(["send_email"], "enforce")
  assert.equal(explicitToolMustAsk("send_email", enforce), true)
  assert.equal(explicitToolMustAsk("send_email", observe), false)
  assert.equal(explicitToolObserved("send_email", observe), true)
  assert.equal(explicitToolObserved("send_email", enforce), false)
  assert.equal(explicitToolObserved("write", observe), false)
})

test("a listed request is labelled outbound unless the profile names its class", () => {
  const listed = readExplicitToolPolicy(["im_send"], "observe")
  const tool = "mcp__cognia-plugin-tools__im_send"
  assert.equal(
    requestPermissionClass({ kind: "none" }, null, tool, EMPTY_PLUGIN_CLASS_INDEX, listed),
    "outbound"
  )
  assert.equal(
    requestPermissionClass({ kind: "always-ask", cls: "secrets" }, PROFILE, tool, INDEX, listed),
    "secrets"
  )
  assert.equal(
    requestPermissionClass({ kind: "none" }, PROFILE, "mcp__cognia-tools__write", INDEX, listed),
    "workspace"
  )
  assert.equal(
    requestPermissionClass({ kind: "none" }, null, "mcp__cognia-tools__write", INDEX, listed),
    undefined
  )
})

test("the observation frame carries the call and its class", () => {
  assert.deepEqual(explicitToolAllowedFrame("s1", "send_email", { to: "a@b.c" }, "tu-1"), {
    type: "explicit_tool_allowed",
    sessionId: "s1",
    toolUseID: "tu-1",
    toolName: "send_email",
    input: { to: "a@b.c" },
    permissionClass: "outbound",
  })
  assert.equal("toolUseID" in explicitToolAllowedFrame("s1", "send_email", {}), false)
})
