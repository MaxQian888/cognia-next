// Tests for the web_clone / web_clone_convert SDK tool handlers: result
// shaping, error paths, and the fixed tool-registration order guard. Uses an
// injected fake spawn so no real engine process runs.

import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  execWebClone,
  execWebCloneConvert,
  webcloneTools,
  WEBCLONE_TOOL_NAMES,
  __testExports,
} from "./index.mjs"

function realCwd() {
  return mkdtempSync(join(tmpdir(), "wc-idx-"))
}

function fakeSpawnDeps(envelope) {
  const spawn = () => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => child.emit("close", null)
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(JSON.stringify(envelope) + "\n"))
      child.emit("close", 0)
    })
    return child
  }
  return {
    spawn,
    fs: { writeFile: async () => {}, unlink: async () => {}, mkdir: async () => {} },
    tmpDir: tmpdir(),
    randomId: () => "id",
    runnerPath: "runner.js",
    nodeExec: "node",
  }
}

function textOf(result) {
  return result.content.map((c) => c.text).join("")
}

test("tool registration order is fixed and matches names", () => {
  assert.deepEqual(
    webcloneTools.map((t) => t.name),
    [...WEBCLONE_TOOL_NAMES]
  )
  assert.deepEqual([...WEBCLONE_TOOL_NAMES], ["web_clone", "web_clone_convert"])
})

test("envelopeToResult summarizes a success envelope", () => {
  const r = __testExports.envelopeToResult(
    {
      ok: true,
      result: {
        sourceUrl: "https://x/",
        mode: "single",
        output: "/w/o.html",
        stats: { total: 3, fetched: 2, failed: 1 },
        assets: Array.from({ length: 500 }, (_, i) => ({
          originUrl: `a${i}`,
          type: "img",
          status: "fetched",
          size: 1,
        })),
      },
    },
    "web_clone"
  )
  assert.equal(r.isError, undefined)
  const payload = JSON.parse(textOf(r))
  assert.match(payload.message, /2\/3 assets fetched, 1 failed/)
  assert.equal(payload.assets.length, 200, "asset detail is capped")
})

test("envelopeToResult surfaces a failure envelope as an error result", () => {
  const r = __testExports.envelopeToResult(
    { ok: false, error: { message: "blocked" } },
    "web_clone"
  )
  assert.equal(r.isError, true)
  assert.match(textOf(r), /web_clone: blocked/)
})

test("execWebClone returns a success result via the injected engine", async () => {
  const cwd = realCwd()
  try {
    const deps = fakeSpawnDeps({
      ok: true,
      result: {
        sourceUrl: "https://x/",
        mode: "bundle",
        output: "/w/site",
        stats: { total: 1, fetched: 1, failed: 0 },
        assets: [],
      },
    })
    const r = await execWebClone(
      { cwd, url: "https://example.com/", output: "site", mode: "bundle" },
      deps
    )
    assert.equal(r.isError, undefined)
    assert.match(textOf(r), /Snapshot written to/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("execWebClone maps a blocked target to an error result (no spawn needed)", async () => {
  const cwd = realCwd()
  try {
    // allowPrivateHosts omitted → SSRF pre-check blocks before spawn.
    const r = await execWebClone(
      { cwd, url: "http://169.254.169.254/", output: "o.html" },
      fakeSpawnDeps({ ok: true })
    )
    assert.equal(r.isError, true)
    assert.match(textOf(r), /private\/loopback/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("execWebClone maps a thrown validation error to an error result", async () => {
  // Missing url → buildJob throws → toolError.
  const r = await execWebClone({ cwd: realCwd(), output: "o.html" }, fakeSpawnDeps({ ok: true }))
  assert.equal(r.isError, true)
  assert.match(textOf(r), /web_clone: .*url is required/)
})

test("execWebCloneConvert runs the convert path", async () => {
  const cwd = realCwd()
  try {
    const deps = fakeSpawnDeps({
      ok: true,
      result: {
        sourceUrl: cwd,
        mode: "convert",
        output: "/w/gen",
        stats: { total: 2, fetched: 0, failed: 0 },
        assets: [],
      },
    })
    const r = await execWebCloneConvert(
      { cwd, input: "snap", output: "gen", framework: "svelte" },
      deps
    )
    assert.equal(r.isError, undefined)
    assert.match(textOf(r), /Snapshot written to/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
