import { test } from "node:test"
import assert from "node:assert/strict"

import {
  EMPTY_PLUGIN_CLASS_INDEX,
  buildPluginClassIndex,
  classesOfTool,
  isSandboxExecuted,
  profileDenialMessage,
  profileVerdict,
  readApprovalTtlMs,
  readPermissionProfile,
  readSandboxAttested,
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
