import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"

import { SIDECAR_ROOT, resolveSidecarRoot, sidecarPath } from "./sidecar-paths.ts"

test("in the source tree the root is the sidecar package", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(SIDECAR_ROOT, "package.json"), "utf8"))
  assert.equal(manifest.name, "cognia-claude-sidecar")
  assert.equal(sidecarPath("agent-host.mjs"), path.join(SIDECAR_ROOT, "agent-host.mjs"))
})

test("a module in src/platform resolves two levels up", () => {
  const root = path.join(path.sep, "opt", "app", "sidecar")
  assert.equal(resolveSidecarRoot(path.join(root, "src", "platform")), root)
})

test("a bundled copy treats its own directory as the root", () => {
  const bundleDir = path.join(path.sep, "opt", "cognia-agent", "sidecar")
  assert.equal(resolveSidecarRoot(bundleDir), bundleDir)
  // Only the exact source location counts; a look-alike suffix does not.
  const lookalike = path.join(path.sep, "opt", "x", "mysrc", "platform")
  assert.equal(resolveSidecarRoot(lookalike), lookalike)
})
