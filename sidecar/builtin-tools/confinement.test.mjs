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
  assert.equal(bareToolName("mcp__server__a__b"), "a__b")
})

test("assertNotSecretEscape throws on credential targets, passes otherwise", () => {
  const root = mkRoot()
  assert.throws(() => assertNotSecretEscape(root, path.join(os.homedir(), ".ssh", "x")))
  assert.doesNotThrow(() => assertNotSecretEscape(root, path.join(root, "ok.txt")))
})
