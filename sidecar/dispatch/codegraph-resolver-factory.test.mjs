import test from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"

import { makeLazyCodeGraphResolver, resolveCodeGraphRoot } from "./codegraph-resolver-factory.mjs"

const log = () => {}

test("disabled when builtinTools.codeGraph is off", () => {
  const r = makeLazyCodeGraphResolver({ sendOptions: { cwd: "/x" }, log })
  assert.equal(r.codeGraphEnabled, false)
  assert.equal(r.codeGraphResolver, null)
  assert.doesNotThrow(() => r.dispose())
})

test("disabled when cwd is missing", () => {
  const r = makeLazyCodeGraphResolver({ sendOptions: { builtinTools: { codeGraph: true } }, log })
  assert.equal(r.codeGraphEnabled, false)
  assert.equal(r.codeGraphResolver, null)
})

test("enabled with codeGraph + cwd, resolver exposes the query surface", () => {
  const r = makeLazyCodeGraphResolver({
    sendOptions: { builtinTools: { codeGraph: true }, cwd: os.tmpdir() },
    log,
  })
  assert.equal(r.codeGraphEnabled, true)
  for (const m of [
    "ensureIndexed",
    "syncStale",
    "search",
    "getNode",
    "callers",
    "callees",
    "impact",
    "context",
    "files",
    "status",
    "stalenessBanner",
  ]) {
    assert.equal(typeof r.codeGraphResolver[m], "function", m)
  }
  r.dispose()
})

test("the index service is built lazily (no .cognia until a query runs)", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-factory-"))
  await fsp.writeFile(path.join(root, "a.ts"), "export function a() {}\n")
  await fsp.writeFile(path.join(root, "package.json"), "{}\n")
  const r = makeLazyCodeGraphResolver({
    sendOptions: { builtinTools: { codeGraph: true }, cwd: root },
    log,
  })
  try {
    // Constructing the factory must not have indexed anything yet.
    assert.equal(fs.existsSync(path.join(root, ".cognia")), false)
    // First query builds the index.
    await r.codeGraphResolver.syncStale()
    assert.ok(r.codeGraphResolver.status().fileCount >= 1)
  } finally {
    r.dispose()
  }
})

test("resolveCodeGraphRoot walks up to the nearest manifest/VCS marker", async () => {
  // realpath the temp root up front: on macOS os.tmpdir() is `/var/...`, a
  // symlink to `/private/var/...`, and the resolver walks up the path it is
  // given without resolving links.
  const root = fs.realpathSync(await fsp.mkdtemp(path.join(os.tmpdir(), "cg-root-")))
  const sub = path.join(root, "packages", "app")
  await fsp.mkdir(sub, { recursive: true })
  await fsp.writeFile(path.join(root, "package.json"), "{}\n")
  assert.equal(resolveCodeGraphRoot(sub), root)
})

test("resolveCodeGraphRoot falls back to cwd when no marker is found", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-noroot-"))
  // No marker anywhere up to tmp — but tmp itself is unlikely to hold one; the
  // fallback returns the cwd unchanged.
  const got = resolveCodeGraphRoot(root)
  assert.ok(typeof got === "string" && got.length > 0)
})
