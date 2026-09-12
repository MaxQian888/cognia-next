// Dispatch-level coverage for the anthropic rail's plugin-access wiring:
// `createAnthropicCanUseTool` must build the plugin-access map from
// `sendOptions.pluginTools` itself — if that construction regresses, a
// declared-read plugin tool (e.g. ripgrep_search) silently loses the
// built-in credential-path deny.

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { createAnthropicCanUseTool } from "./anthropic.mjs"
import { createDoomLoopGuard } from "./doom-loop.mjs"

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cognia-canusetool-"))
}

function mkGate(sendOptions, { emit = () => {}, pendingApprovals = new Map() } = {}) {
  return createAnthropicCanUseTool({
    sendOptions,
    sessionId: "s1",
    emit,
    log: () => {},
    pendingApprovals,
    pluginToolNameAliases: new Map(),
    doomGuard: createDoomLoopGuard(),
  })
}

const RG_TOOL = "mcp__cognia-plugin-tools__ripgrep-tools:ripgrep_search"
const RG_ENTRY = {
  name: "ripgrep-tools:ripgrep_search",
  description: "search",
  jsonSchema: {},
  pluginId: "ripgrep-tools",
  access: "read",
  pathParams: ["path"],
}

test("anthropic canUseTool denies a declared-read plugin tool on a credential path", async () => {
  const root = mkRoot()
  const secret = path.join(root, ".ssh", "id_rsa")
  // A ruleset allow would otherwise approve this silently — only the
  // plugin-access map turns it into a confinement deny.
  const canUseTool = mkGate({
    permissionRuleset: { [RG_TOOL]: "allow" },
    confinement: { enabled: true, roots: [root] },
    cwd: root,
    pluginTools: [RG_ENTRY],
  })
  const res = await canUseTool(RG_TOOL, { path: secret }, {})
  assert.equal(res.behavior, "deny")
  assert.match(res.message, /credential|protected|denied/)
})

test("anthropic canUseTool keeps undeclared plugin tools opaque to confinement", async () => {
  const root = mkRoot()
  const secret = path.join(root, ".ssh", "id_rsa")
  const canUseTool = mkGate({
    permissionRuleset: { [RG_TOOL]: "allow" },
    confinement: { enabled: true, roots: [root] },
    cwd: root,
    pluginTools: [], // no manifest entry → no access class → opaque
  })
  const res = await canUseTool(RG_TOOL, { path: secret }, {})
  assert.equal(res.behavior, "allow")
})

test("anthropic canUseTool honors manifest-declared pathParams beyond PATH_KEYS", async () => {
  const root = mkRoot()
  const secret = path.join(root, ".aws", "credentials")
  const tool = "mcp__cognia-plugin-tools__my-plugin:exporter"
  const canUseTool = mkGate({
    permissionRuleset: { [tool]: "allow" },
    confinement: { enabled: true, roots: [root] },
    cwd: root,
    pluginTools: [
      {
        name: "my-plugin:exporter",
        description: "x",
        jsonSchema: {},
        pluginId: "my-plugin",
        access: "read",
        pathParams: ["export_dest"],
      },
    ],
  })
  // `export_dest` is not a built-in PATH_KEY — only the declared pathParams
  // make the credential deny see it.
  const res = await canUseTool(tool, { export_dest: secret }, {})
  assert.equal(res.behavior, "deny")
})

test("anthropic canUseTool escalates a declared-write plugin tool escaping the roots", async () => {
  const root = mkRoot()
  const outside = path.join(mkRoot(), "out.txt")
  const tool = "mcp__cognia-plugin-tools__my-plugin:file_writer"
  const emitted = []
  const pending = new Map()
  const canUseTool = mkGate(
    {
      confinement: { enabled: true, roots: [root] },
      cwd: root,
      pluginTools: [
        {
          name: "my-plugin:file_writer",
          description: "w",
          jsonSchema: {},
          pluginId: "my-plugin",
          access: "write",
          pathParams: ["path"],
        },
      ],
    },
    {
      emit: (ev) => {
        emitted.push(ev)
        // Auto-approve so the round-trip resolves.
        queueMicrotask(() =>
          pending.get(ev.requestId)?.resolve({ behavior: "allow", updatedInput: { ok: 1 } })
        )
      },
      pendingApprovals: pending,
    }
  )
  const res = await canUseTool(tool, { path: outside }, {})
  // Confinement "ask" falls through to the approval round-trip.
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].type, "permission_request")
  assert.equal(emitted[0].toolName, tool)
  assert.equal(res.behavior, "allow")
  assert.deepEqual(res.updatedInput, { ok: 1 })
})

test("anthropic canUseTool survives non-array pluginTools", async () => {
  const root = mkRoot()
  // A foreign/legacy sender shape must degrade to opaque, not throw.
  for (const bad of [undefined, null, "str", { name: "x" }]) {
    const canUseTool = mkGate({
      permissionRuleset: { [RG_TOOL]: "allow" },
      confinement: { enabled: true, roots: [root] },
      cwd: root,
      pluginTools: bad,
    })
    const res = await canUseTool(RG_TOOL, { path: "src" }, {})
    assert.equal(res.behavior, "allow")
  }
})

test("approval input rewrites are checked against the same hard authority", async () => {
  const pendingApprovals = new Map()
  const gate = mkGate({}, { pendingApprovals })
  const pending = gate("Read", { path: "/workspace/safe" }, {})
  const entry = [...pendingApprovals.values()][0]
  assert.ok(entry)
  entry.resolve({ behavior: "allow", updatedInput: { content: "private@example.com" } })
  assert.equal((await pending).behavior, "deny")
})
