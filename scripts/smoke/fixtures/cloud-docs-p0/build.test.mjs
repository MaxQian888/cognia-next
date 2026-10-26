import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { CACHE_OUTPUT, PUBLIC_OUTPUT, buildFixture, fixtureModules, parseArgs } from "./build.mjs"

test("defaults to the gitignored cache output", () => {
  assert.deepEqual(parseArgs([], "/repo"), {
    output: path.join("/repo", CACHE_OUTPUT),
    force: false,
  })
})

test("--public targets the dev-server path and --force replaces", () => {
  assert.deepEqual(parseArgs(["--public", "--force"], "/repo"), {
    output: path.join("/repo", PUBLIC_OUTPUT),
    force: true,
  })
})

test("rejects unknown arguments", () => {
  assert.throws(() => parseArgs(["--publc"], "/repo"), /unknown argument/)
})

test("stubs wrap the real modules under the given root", () => {
  const modules = fixtureModules("/repo")
  assert.match(modules["@/lib/docs-providers"], /\/repo\/lib\/docs-providers\/types\.ts/)
  assert.match(
    modules["@/lib/chat/attachments/prepare"],
    /\/repo\/lib\/chat\/attachments\/prepare\.ts/
  )
  assert.match(modules["@/lib/docs-providers"], /window\.p0Fixture =/)
})

test("refuses to overwrite an existing output without --force", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p0-fixture-"))
  try {
    await assert.rejects(buildFixture({ output: dir, force: false }), /already exists/)
    assert.ok(fs.existsSync(dir))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
