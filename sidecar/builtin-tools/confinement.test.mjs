// Unit tests for workspace confinement (ADR-0028 "lite").

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  isSecretPath,
  classifyPathForConfinement,
  classifyToolCallConfinement,
  combineVerdict,
  bareToolName,
  buildPluginAccessMap,
  assertNotSecretEscape,
} from "./confinement.mjs"

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cognia-conf-"))
}

test("isSecretPath flags credential directories and files", () => {
  assert.equal(isSecretPath(path.join(os.homedir(), ".ssh", "id_rsa")), true)
  assert.equal(isSecretPath(path.join(os.homedir(), ".aws", "credentials")), true)
  assert.equal(isSecretPath(path.join(os.homedir(), ".git-credentials")), true)
  assert.equal(isSecretPath(path.join(os.homedir(), ".npmrc")), true)
  assert.equal(isSecretPath(path.join(os.homedir(), ".config", "gh", "hosts.yml")), true)
  // Rust-protected Cognia app-data dirs (parity with protected.rs).
  assert.equal(isSecretPath(path.join(os.homedir(), ".config", "cognia", "x")), true)
  assert.equal(isSecretPath(path.join(os.homedir(), ".local", "share", "cognia", "x")), true)
  assert.equal(isSecretPath(path.join(os.homedir(), ".cargo", "credentials.toml")), true)
  assert.equal(
    isSecretPath(path.join(os.homedir(), "Library", "Application Support", "cognia", "x")),
    true
  )
  assert.equal(isSecretPath(path.join(os.homedir(), "AppData", "Roaming", "cognia", "x")), true)
  assert.equal(isSecretPath(path.join(os.homedir(), "AppData", "Local", "cognia", "x")), true)
})

test("isSecretPath does NOT flag .env or ordinary project files", () => {
  assert.equal(isSecretPath(path.join(os.tmpdir(), "proj", ".env")), false)
  assert.equal(isSecretPath(path.join(os.tmpdir(), "proj", "src", "index.ts")), false)
  assert.equal(isSecretPath(""), false)
})

test("classifyPathForConfinement: inside root allows read and write", () => {
  const root = mkRoot()
  const inside = path.join(root, "src", "a.ts")
  assert.equal(classifyPathForConfinement(root, [root], inside, "write"), "allow")
  assert.equal(classifyPathForConfinement(root, [root], inside, "read"), "allow")
  // Relative target resolves against cwd (= root).
  assert.equal(classifyPathForConfinement(root, [root], "pkg/b.ts", "write"), "allow")
})

test("classifyPathForConfinement: outside root asks for writes, allows reads", () => {
  const root = mkRoot()
  const outside = mkRoot() // a sibling temp dir, not under `root`
  const target = path.join(outside, "escape.txt")
  assert.equal(classifyPathForConfinement(root, [root], target, "write"), "ask")
  assert.equal(classifyPathForConfinement(root, [root], target, "read"), "allow")
})

test("classifyPathForConfinement: credential path denies in every op", () => {
  const root = mkRoot()
  const secret = path.join(os.homedir(), ".ssh", "authorized_keys")
  assert.equal(classifyPathForConfinement(root, [root], secret, "write"), "deny")
  assert.equal(classifyPathForConfinement(root, [root], secret, "read"), "deny")
})

test("classifyPathForConfinement: symlink escape into a secret path denies", (t) => {
  const root = mkRoot()
  const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-ssh-"))
  // Rename the real dir to look like a credential store so isSecretPath(real) trips.
  const fakeSsh = path.join(path.dirname(secretDir), ".ssh")
  try {
    fs.renameSync(secretDir, fakeSsh)
  } catch {
    return t.skip("cannot stage fake .ssh dir")
  }
  const link = path.join(root, "link")
  try {
    fs.symlinkSync(fakeSsh, link, "junction")
  } catch {
    // Windows without symlink privilege / dev mode — skip the symlink leg.
    return t.skip("symlink creation not permitted")
  }
  // Lexically the path is inside `root`, but it resolves into the fake .ssh dir.
  const target = path.join(link, "id_rsa")
  assert.equal(classifyPathForConfinement(root, [root], target, "write"), "deny")
})

test("classifyToolCallConfinement is operation-aware", () => {
  const root = mkRoot()
  const outside = path.join(mkRoot(), "x.ts")
  const policy = { enabled: true, roots: [root] }

  // Mutator escaping the workspace → ask.
  assert.equal(classifyToolCallConfinement(policy, "write", { file_path: outside }, root), "ask")
  assert.equal(
    classifyToolCallConfinement(policy, "mcp__cognia-tools__edit", { file_path: outside }, root),
    "ask"
  )
  // Reader escaping the workspace → no opinion (null): reads are unconfined.
  assert.equal(classifyToolCallConfinement(policy, "read", { file_path: outside }, root), null)
  assert.equal(classifyToolCallConfinement(policy, "grep", { path: outside }, root), null)
  // In-root mutator → no opinion (null): confinement never auto-approves.
  assert.equal(
    classifyToolCallConfinement(policy, "write", { file_path: path.join(root, "a") }, root),
    null
  )
  // Secret target → deny regardless of op class.
  assert.equal(
    classifyToolCallConfinement(
      policy,
      "read",
      { file_path: path.join(os.homedir(), ".aws", "credentials") },
      root
    ),
    "deny"
  )
})

test("classifyToolCallConfinement: bash workdir escape asks, default workdir is fine", () => {
  const root = mkRoot()
  const outside = mkRoot()
  const policy = { enabled: true, roots: [root] }
  assert.equal(classifyToolCallConfinement(policy, "bash", { workdir: outside }, root), "ask")
  // No explicit workdir → runs in cwd (inside root) → no target → null.
  assert.equal(classifyToolCallConfinement(policy, "bash", { command: "ls" }, root), null)
})

test("classifyToolCallConfinement returns null when inapplicable", () => {
  const root = mkRoot()
  const policy = { enabled: true, roots: [root] }
  // Disabled policy.
  assert.equal(
    classifyToolCallConfinement({ enabled: false, roots: [root] }, "write", {}, root),
    null
  )
  // No roots.
  assert.equal(classifyToolCallConfinement({ enabled: true, roots: [] }, "write", {}, root), null)
  // Non-path tool.
  assert.equal(classifyToolCallConfinement(policy, "TodoWrite", { todos: [] }, root), null)
  // Missing policy.
  assert.equal(classifyToolCallConfinement(null, "write", { file_path: "x" }, root), null)
})

test("combineVerdict picks the more-restrictive, null-safe", () => {
  assert.equal(combineVerdict(null, null), null)
  assert.equal(combineVerdict("allow", null), "allow")
  assert.equal(combineVerdict(null, "ask"), "ask")
  assert.equal(combineVerdict("allow", "ask"), "ask")
  assert.equal(combineVerdict("allow", "deny"), "deny")
  assert.equal(combineVerdict("deny", "ask"), "deny")
  assert.equal(combineVerdict("ask", "allow"), "ask")
})

test("bareToolName strips the mcp namespace", () => {
  assert.equal(bareToolName("mcp__cognia-tools__write"), "write")
  assert.equal(bareToolName("write"), "write")
  assert.equal(bareToolName("mcp__server__a__b"), "mcp__server__a__b")
})

test("buildPluginAccessMap filters malformed entries and reserved names", () => {
  // The wire shape mirrors `sendOptions.pluginTools` entries.
  const map = buildPluginAccessMap([
    { name: "ripgrep-tools:ripgrep_search", access: "read", pathParams: ["path"] },
    { name: "my-plugin:file_writer", access: "write" },
    { name: "my-plugin:opaque_tool" },
    { name: "my-plugin:bad_access", access: "exec" },
    { name: 42, access: "read" },
    null,
    "not-an-object",
    // The sandbox_* tools' class is hardcoded — a manifest entry must not
    // re-classify (let alone downgrade) them via the map.
    { name: "sandbox_bash", access: "read" },
    { name: "sandbox_write", access: "read" },
  ])
  assert.deepEqual(map.get("ripgrep-tools:ripgrep_search"), {
    access: "read",
    pathKeys: ["path"],
  })
  assert.deepEqual(map.get("my-plugin:file_writer"), { access: "write", pathKeys: [] })
  assert.equal(map.has("my-plugin:opaque_tool"), false)
  assert.equal(map.has("my-plugin:bad_access"), false)
  assert.equal(map.has("sandbox_bash"), false)
  assert.equal(map.has("sandbox_write"), false)

  // Non-array pluginTools degrades to an empty map rather than throwing —
  // dispatch must survive a foreign/legacy sender shape.
  for (const bad of [undefined, null, "str", { name: "x", access: "read" }, 5]) {
    assert.equal(buildPluginAccessMap(bad).size, 0)
  }
})

test("plugin tools classify by declared access (ripgrep_search parity)", () => {
  const root = mkRoot()
  const secret = path.join(root, ".ssh", "id_rsa")
  const outside = path.join(mkRoot(), "x.ts")
  const policy = { enabled: true, roots: [root] }
  const pluginAccess = buildPluginAccessMap([
    { name: "ripgrep-tools:ripgrep_search", access: "read", pathParams: ["path"] },
    { name: "my-plugin:file_writer", access: "write" },
    { name: "my-plugin:opaque_tool" },
  ])

  // Declared "read" → the credential-path deny applies to the plugin tool,
  // same as the built-in grep. The qualified name keeps its colon.
  assert.equal(
    classifyToolCallConfinement(
      policy,
      "mcp__cognia-plugin-tools__ripgrep-tools:ripgrep_search",
      { path: secret },
      root,
      pluginAccess
    ),
    "deny"
  )
  // In-workspace read → no opinion; read outside → still unconfined.
  assert.equal(
    classifyToolCallConfinement(
      policy,
      "mcp__cognia-plugin-tools__ripgrep-tools:ripgrep_search",
      { path: "src" },
      root,
      pluginAccess
    ),
    null
  )
  assert.equal(
    classifyToolCallConfinement(
      policy,
      "mcp__cognia-plugin-tools__ripgrep-tools:ripgrep_search",
      { path: outside },
      root,
      pluginAccess
    ),
    null
  )
  // Declared "write" → out-of-root targets ask, like a built-in mutator.
  assert.equal(
    classifyToolCallConfinement(
      policy,
      "mcp__cognia-plugin-tools__my-plugin:file_writer",
      { path: outside },
      root,
      pluginAccess
    ),
    "ask"
  )
  // No declared access → opaque, same as before (no map entry and no map at all).
  assert.equal(
    classifyToolCallConfinement(
      policy,
      "mcp__cognia-plugin-tools__my-plugin:opaque_tool",
      { path: secret },
      root,
      pluginAccess
    ),
    null
  )
  assert.equal(
    classifyToolCallConfinement(
      policy,
      "mcp__cognia-plugin-tools__my-plugin:opaque_tool",
      { path: secret },
      root
    ),
    null
  )
})

test("plugin pathParams join the confinement path-key set", () => {
  const root = mkRoot()
  const secret = path.join(root, ".aws", "credentials")
  const policy = { enabled: true, roots: [root] }
  // `export_dest` is NOT a built-in PATH_KEY — only the declared pathParams
  // make it a confinement target.
  const pluginAccess = buildPluginAccessMap([
    { name: "my-plugin:exporter", access: "read", pathParams: ["export_dest"] },
  ])
  assert.equal(
    classifyToolCallConfinement(
      policy,
      "mcp__cognia-plugin-tools__my-plugin:exporter",
      { export_dest: secret },
      root,
      pluginAccess
    ),
    "deny"
  )
  // Without pathParams the unconventional key is invisible — documented gap.
  const noKeys = buildPluginAccessMap([{ name: "my-plugin:exporter", access: "read" }])
  assert.equal(
    classifyToolCallConfinement(
      policy,
      "mcp__cognia-plugin-tools__my-plugin:exporter",
      { export_dest: secret },
      root,
      noKeys
    ),
    null
  )
})

test("assertToolCallWithinRoots honors declared plugin access", async () => {
  const { assertToolCallWithinRoots } = await import("./confinement.mjs")
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
  const { assertToolCallWithinRoots } = await import("./confinement.mjs")
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
