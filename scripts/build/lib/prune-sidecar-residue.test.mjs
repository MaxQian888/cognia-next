import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { JS_LAYOUT_SIDECAR_ENTRIES, pruneSidecarResidue } from "./prune-sidecar-residue.mjs"

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "prune-sidecar-"))
}

test("removes a leftover bundled host and its siblings but keeps what the JS layout owns", () => {
  const outDir = scratch()
  const sidecar = path.join(outDir, "sidecar")
  fs.mkdirSync(path.join(sidecar, "pi-extension"), { recursive: true })
  fs.writeFileSync(path.join(sidecar, "pi-extension", "index.mjs"), "x")
  fs.writeFileSync(path.join(sidecar, "ast-grep"), "bin")
  fs.writeFileSync(path.join(sidecar, "claude-host.mjs"), "stale")
  fs.writeFileSync(path.join(sidecar, "cognia-tool-bridge.mjs"), "stale")
  fs.mkdirSync(path.join(sidecar, "node_modules", "dep"), { recursive: true })
  fs.writeFileSync(path.join(sidecar, "node_modules", "dep", "index.js"), "stale")
  const lines = []
  const removed = pruneSidecarResidue({ outDir, log: (l) => lines.push(l) })
  assert.deepEqual(removed.sort(), ["claude-host.mjs", "cognia-tool-bridge.mjs", "node_modules"])
  assert.equal(fs.existsSync(path.join(sidecar, "claude-host.mjs")), false)
  assert.equal(fs.existsSync(path.join(sidecar, "node_modules")), false)
  assert.equal(fs.existsSync(path.join(sidecar, "pi-extension", "index.mjs")), true)
  assert.equal(fs.existsSync(path.join(sidecar, "ast-grep")), true)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /removed 3 stale sidecar entries/)
})

test("is a no-op without a sidecar directory or with only owned entries", () => {
  const empty = scratch()
  assert.deepEqual(pruneSidecarResidue({ outDir: empty }), [])
  const owned = scratch()
  fs.mkdirSync(path.join(owned, "sidecar"), { recursive: true })
  for (const entry of JS_LAYOUT_SIDECAR_ENTRIES) {
    fs.writeFileSync(path.join(owned, "sidecar", entry), "x")
  }
  const lines = []
  assert.deepEqual(pruneSidecarResidue({ outDir: owned, log: (l) => lines.push(l) }), [])
  assert.deepEqual(lines, [])
})
