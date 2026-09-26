/**
 * Coverage for scripts/gates/lib/companion-source-paths.mjs.
 *
 * Run with: node --test scripts/gates/lib/companion-source-paths.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  COMPANION_SOURCES,
  isRpcSource,
  requireCompanionSources,
  rpcFamilyFile,
} from "./companion-source-paths.mjs"

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)))

// The map is only useful while it is true: a move that forgets to update it
// fails here, before any gate reads a stale path.
test("every mapped path exists in the repository", () => {
  for (const [name, path] of Object.entries(COMPANION_SOURCES)) {
    assert.ok(existsSync(join(REPO_ROOT, path)), `${name}: ${path} does not exist`)
  }
})

test("rpc family files sit in the family directory", () => {
  assert.equal(rpcFamilyFile("chat"), `${COMPANION_SOURCES.rpcFamilyDir}/chat.rs`)
  assert.ok(existsSync(join(REPO_ROOT, rpcFamilyFile("chat"))))
})

test("isRpcSource accepts the router and family files only", () => {
  assert.ok(isRpcSource(COMPANION_SOURCES.rpcRouter))
  assert.ok(isRpcSource(rpcFamilyFile("terminal")))
  assert.ok(!isRpcSource(`${COMPANION_SOURCES.rpcFamilyDir}/README.md`))
  assert.ok(!isRpcSource(COMPANION_SOURCES.browserGateway))
  assert.ok(!isRpcSource(`${COMPANION_SOURCES.rpcFamilyDir}.rs.bak`))
})

test("requireCompanionSources returns the list when everything exists", () => {
  const paths = ["a.rs", "b/c.rs"]
  assert.equal(
    requireCompanionSources(paths, "/root", () => true),
    paths
  )
})

test("requireCompanionSources refuses an empty list", () => {
  assert.throws(
    () => requireCompanionSources([], "/root", () => true),
    /empty.*companion-source-paths\.mjs/
  )
})

test("requireCompanionSources names every missing file", () => {
  assert.throws(
    () =>
      requireCompanionSources(["here.rs", "gone.rs", "also-gone.rs"], "/root", (p) =>
        p.endsWith("here.rs")
      ),
    /gone\.rs, also-gone\.rs.*companion-source-paths\.mjs/
  )
})
