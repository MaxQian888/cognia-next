// Workspace confinement (ADR-0028 "lite"): the tool-body guards.

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { buildPluginAccessMap } from "./classify.ts"
import { assertNotSecretEscape, assertToolCallWithinRoots } from "./enforce.ts"

function mkRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cognia-conf-"))
}

test("assertToolCallWithinRoots honors declared plugin access", async () => {
  const policy = { writableRoots: ["/workspace"] }
  const pluginAccess = buildPluginAccessMap([
    { name: "ripgrep-tools:ripgrep_search", access: "read", pathParams: ["path"] },
  ])

  // Credential-shaped targets refuse even for a "read"-class plugin tool.
  assert.throws(
    () =>
      assertToolCallWithinRoots(
        policy,
        "mcp__cognia-plugin-tools__ripgrep-tools:ripgrep_search",
        { path: "/workspace/.ssh/id_rsa" },
        "/workspace",
        pluginAccess
      ),
    /sandbox refused/
  )
  assert.doesNotThrow(() =>
    assertToolCallWithinRoots(
      policy,
      "mcp__cognia-plugin-tools__ripgrep-tools:ripgrep_search",
      { path: "src" },
      "/workspace",
      pluginAccess
    )
  )
  // Undeclared access → the tool stays opaque to the scope gate.
  assert.doesNotThrow(() =>
    assertToolCallWithinRoots(
      policy,
      "mcp__cognia-plugin-tools__other-plugin:opaque",
      { path: "/workspace/.ssh/id_rsa" },
      "/workspace",
      pluginAccess
    )
  )
})

test("assertNotSecretEscape throws on credential targets, passes otherwise", () => {
  const root = mkRoot()
  assert.throws(() => assertNotSecretEscape(root, path.join(os.homedir(), ".ssh", "x")))
  assert.doesNotThrow(() => assertNotSecretEscape(root, path.join(root, "ok.txt")))
})

test("executor scope rejects relocation destinations and nested edits outside writable roots", async () => {
  const policy = { writableRoots: ["/workspace"] }
  assert.doesNotThrow(() =>
    assertToolCallWithinRoots(policy, "directory_create", { path: "new" }, "/workspace")
  )
  assert.throws(
    () =>
      assertToolCallWithinRoots(
        policy,
        "file_move",
        { source: "inside", destination: "/outside" },
        "/workspace"
      ),
    /sandbox refused/
  )
  assert.throws(
    () =>
      assertToolCallWithinRoots(
        policy,
        "multi_edit",
        { edits: [{ file_path: "/outside" }] },
        "/workspace"
      ),
    /sandbox refused/
  )
  assert.throws(
    () =>
      assertToolCallWithinRoots(
        { writableRoots: [] },
        "directory_create",
        { path: "new" },
        "/workspace"
      ),
    /sandbox refused/
  )
})
