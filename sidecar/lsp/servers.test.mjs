import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { nearestRoot, serversForFile, SERVERS } from "./servers.mjs"

function mkProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cognia-lsp-servers-"))
}

test("nearestRoot finds the directory containing a marker", () => {
  const root = mkProject()
  fs.writeFileSync(path.join(root, "package.json"), "{}")
  const sub = path.join(root, "src", "deep")
  fs.mkdirSync(sub, { recursive: true })
  const file = path.join(sub, "index.ts")
  fs.writeFileSync(file, "")

  const find = nearestRoot(["package.json"])
  assert.equal(find(file, { cwd: root }), fs.realpathSync(root))
})

test("nearestRoot stops at cwd boundary and returns undefined when no marker", () => {
  const root = mkProject()
  const sub = path.join(root, "a", "b")
  fs.mkdirSync(sub, { recursive: true })
  const file = path.join(sub, "x.ts")
  fs.writeFileSync(file, "")
  const find = nearestRoot(["package.json"])
  assert.equal(find(file, { cwd: root }), undefined)
})

test("nearestRoot exclude marker disables the server for that tree", () => {
  const root = mkProject()
  fs.writeFileSync(path.join(root, "package.json"), "{}")
  fs.writeFileSync(path.join(root, "deno.json"), "{}")
  const file = path.join(root, "main.ts")
  fs.writeFileSync(file, "")
  const find = nearestRoot(["package.json"], { excludeMarkers: ["deno.json"] })
  assert.equal(find(file, { cwd: root }), undefined)
})

test("serversForFile matches by extension", () => {
  assert.deepEqual(
    serversForFile("/x/y/a.ts").map((s) => s.id),
    ["typescript"]
  )
  assert.deepEqual(
    serversForFile("/x/y/a.rs").map((s) => s.id),
    ["rust-analyzer"]
  )
  assert.deepEqual(
    serversForFile("/x/y/a.go").map((s) => s.id),
    ["gopls"]
  )
  assert.deepEqual(
    serversForFile("/x/y/a.py").map((s) => s.id),
    ["pyright"]
  )
  assert.deepEqual(serversForFile("/x/y/a.txt"), [])
  assert.deepEqual(serversForFile("/x/y/noext"), [])
})

test("every server resolveCommand yields a command", () => {
  for (const s of SERVERS) {
    const spawn = s.resolveCommand("/tmp/proj", { cwd: "/tmp/proj" })
    assert.equal(typeof spawn.command, "string")
    assert.ok(spawn.command.length > 0)
  }
})
