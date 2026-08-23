import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"


import { isLinkedCopyStale, linkedPackages, parseArgs } from "./build-webclone-sidecar.mjs"

// Resolved from this file, not the cwd: `scripts:test:build` globs these
// suites from the repo root, but a single-file run need not.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

test("parseArgs supports install-only mode and rejects unknown options", () => {
  assert.deepEqual(parseArgs([]), { installOnly: false })
  assert.deepEqual(parseArgs(["--install-only"]), { installOnly: true })
  assert.throws(() => parseArgs(["--unknown"]), /unknown option/i)
})

test("isLinkedCopyStale treats a copy older than its build as stale", () => {
  assert.equal(isLinkedCopyStale(2000, 1000), true)
  assert.equal(isLinkedCopyStale(1000, 2000), false)
  // npm stamps the copy at or after the pack, so equal is current.
  assert.equal(isLinkedCopyStale(1000, 1000), false)
})

test("isLinkedCopyStale treats a missing or unreadable copy as stale", () => {
  // `newestMtimeMs` answers 0 for a directory that does not exist or is empty.
  assert.equal(isLinkedCopyStale(1000, 0), true)
  // An unbuilt source is stale too: there is nothing to trust the copy against.
  assert.equal(isLinkedCopyStale(0, 1000), true)
  assert.equal(isLinkedCopyStale(0, 0), true)
})

test("every linked package is declared as a file: dependency of the engine", () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, "sidecar", "webclone", "package.json"), "utf8"))
  for (const pkg of linkedPackages) {
    const name = `@cognia/${pkg.split("/").pop()}`
    const spec = manifest.dependencies?.[name]
    assert.ok(spec, `${name} is missing from sidecar/webclone dependencies`)
    assert.match(spec, /^file:/, `${name} must be a file: dependency, got ${spec}`)
  }
})
