import assert from "node:assert/strict"
import { test } from "node:test"

import {
  BUILTIN_CHUNK_URL_PREFIX,
  PLUGIN_ARTIFACT_SECTIONS,
  assertSetRelativePath,
} from "./plugin-artifact-format.mjs"

test("sections map to distinct set and host locations", () => {
  const sets = Object.values(PLUGIN_ARTIFACT_SECTIONS).map((section) => section.set)
  const hosts = Object.values(PLUGIN_ARTIFACT_SECTIONS).map((section) => section.host)
  assert.equal(new Set(sets).size, sets.length)
  assert.equal(new Set(hosts).size, hosts.length)
  // Chunk URLs are served from the builtin chunk section's host directory.
  assert.equal(`public${BUILTIN_CHUNK_URL_PREFIX}`, PLUGIN_ARTIFACT_SECTIONS.builtinChunks.host)
})

test("set paths must be plain relative paths", () => {
  assert.equal(assertSetRelativePath("builtin-plugins/a/b.cjs"), "builtin-plugins/a/b.cjs")
  for (const bad of ["", "/abs", "a/../b", "a//b", "./a", "a\\b", "c:/x", 42]) {
    assert.throws(() => assertSetRelativePath(bad), /Unsafe plugin artifact path/)
  }
})
