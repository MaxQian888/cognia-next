// Tests for the web-clone tool orchestration (job building, output confinement,
// SSRF pre-check, and the child-process runner) with a fully injected fake
// spawn + fs, so nothing real is spawned and no network is touched.

import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildJob, runEngine, snapshotSite } from "./run.mjs"

function realCwd(prefix = "wc-tool-") {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** A fake spawn whose child emits a scripted stdout envelope + close/error. */
function fakeSpawn({ stdout = "", stderr = "", code = 0, error = null, hang = false } = {}) {
  const calls = []
  const spawn = (file, args, opts) => {
    calls.push({ file, args, opts })
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {
      // Emulate a killed process closing with a non-zero-ish signal path.
      child.emit("close", null)
    }
    queueMicrotask(() => {
      if (error) {
        child.emit("error", error)
        return
      }
      if (hang) return // never closes on its own → exercises the timeout path
      if (stderr) child.stderr.emit("data", Buffer.from(stderr))
      if (stdout) child.stdout.emit("data", Buffer.from(stdout))
      child.emit("close", code)
    })
    return child
  }
  return { spawn, calls }
}

const memFs = () => ({ writeFile: async () => {}, unlink: async () => {}, mkdir: async () => {} })

function injected(spawnObj, extra = {}) {
  return {
    spawn: spawnObj.spawn,
    fs: memFs(),
    tmpDir: tmpdir(),
    randomId: () => "test-id",
    runnerPath: "runner.js",
    nodeExec: "node",
    ...extra,
  }
}

// ---- buildJob -------------------------------------------------------------

test("buildJob requires cwd, output, and (for snapshot) url", () => {
  assert.throws(() => buildJob({ output: "o", url: "https://x" }), /cwd .* is required/)
  assert.throws(() => buildJob({ cwd: "/w", url: "https://x" }), /output path is required/)
  assert.throws(() => buildJob({ cwd: "/w", output: "o" }), /url is required/)
})

test("buildJob rejects bad mode / framework / frameworkHint", () => {
  const cwd = realCwd()
  try {
    assert.throws(
      () => buildJob({ cwd, output: "o.html", url: "https://x", mode: "zip" }),
      /mode must be one of/
    )
    assert.throws(
      () => buildJob({ cwd, output: "o", url: "https://x", framework: "qwik" }),
      /framework must be one of/
    )
    assert.throws(
      () => buildJob({ cwd, output: "o", url: "https://x", frameworkHint: "angular" }),
      /frameworkHint must be one of/
    )
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("buildJob confines output under cwd (path traversal blocked)", () => {
  const cwd = realCwd()
  try {
    assert.throws(
      () => buildJob({ cwd, output: "../escape.html", url: "https://x" }),
      /escapes root/
    )
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("buildJob builds a snapshot job with clamped tuning + confined output", () => {
  const cwd = realCwd()
  try {
    const job = buildJob({
      cwd,
      url: "https://example.com/",
      output: "site",
      mode: "bundle",
      maxAssets: 99999, // clamps to 5000
      concurrency: 0, // clamps to 1
      timeout: 10, // clamps to 1000
      pretty: true,
    })
    assert.equal(job.mode, "snapshot")
    assert.equal(job.url, "https://example.com/")
    assert.equal(job.options.maxAssets, 5000)
    assert.equal(job.options.concurrency, 1)
    assert.equal(job.options.timeout, 1000)
    assert.equal(job.options.pretty, true)
    assert.ok(job.options.output.startsWith(cwd))
    assert.equal(job.options.extractComponents, false)
    assert.equal(job.options.frameworkCodegen, undefined)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("buildJob: a framework implies component extraction + codegen options", () => {
  const cwd = realCwd()
  try {
    const job = buildJob({
      cwd,
      url: "https://example.com/",
      output: "site",
      framework: "react",
      codegenGenerateDrafts: true,
      codegenExtractShared: true,
    })
    assert.equal(job.options.extractComponents, true)
    assert.deepEqual(job.options.frameworkCodegen, {
      framework: "react",
      typescript: true,
      cssModules: false,
      generateDrafts: true,
      extractSharedLogic: true,
    })
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("buildJob builds a convert job from convertLocal", () => {
  const cwd = realCwd()
  try {
    const job = buildJob({ cwd, convertLocal: "snap", output: "gen", framework: "vue" })
    assert.equal(job.mode, "convert")
    assert.ok(job.options.convertLocal.startsWith(cwd))
    assert.ok(job.options.output.startsWith(cwd))
    assert.equal(job.options.frameworkCodegen.framework, "vue")
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

// ---- runEngine ------------------------------------------------------------

const OK_ENVELOPE = JSON.stringify({
  ok: true,
  result: {
    sourceUrl: "https://x/",
    timestamp: "t",
    mode: "snapshot",
    output: "/w/o",
    stats: {},
    assets: [],
  },
})

test("runEngine parses the runner's stdout envelope", async () => {
  const spawnObj = fakeSpawn({ stdout: OK_ENVELOPE + "\n", stderr: "chatter\n", code: 0 })
  const env = await runEngine(
    { mode: "snapshot", url: "https://x/", options: {} },
    injected(spawnObj)
  )
  assert.equal(env.ok, true)
  assert.equal(env.result.mode, "snapshot")
  // Spawned node with [runnerPath, jobPath].
  assert.equal(spawnObj.calls.length, 1)
  assert.equal(spawnObj.calls[0].file, "node")
  assert.equal(spawnObj.calls[0].args[0], "runner.js")
})

test("runEngine returns a failure envelope even on non-zero exit", async () => {
  const failEnv = JSON.stringify({ ok: false, error: { name: "X", message: "boom" } })
  const spawnObj = fakeSpawn({ stdout: failEnv + "\n", code: 1 })
  const env = await runEngine(
    { mode: "snapshot", url: "https://x/", options: {} },
    injected(spawnObj)
  )
  assert.equal(env.ok, false)
  assert.equal(env.error.message, "boom")
})

test("runEngine throws when the runner produces no output", async () => {
  const spawnObj = fakeSpawn({ stdout: "", stderr: "died\n", code: 1 })
  await assert.rejects(
    () => runEngine({ mode: "snapshot", url: "https://x/", options: {} }, injected(spawnObj)),
    /produced no result/
  )
})

test("runEngine throws on unparseable runner output", async () => {
  const spawnObj = fakeSpawn({ stdout: "not json\n", code: 0 })
  await assert.rejects(
    () => runEngine({ mode: "snapshot", url: "https://x/", options: {} }, injected(spawnObj)),
    /unparseable output/
  )
})

test("runEngine surfaces a spawn error as a thrown 'no result'", async () => {
  const spawnObj = fakeSpawn({ error: new Error("ENOENT") })
  await assert.rejects(
    () => runEngine({ mode: "snapshot", url: "https://x/", options: {} }, injected(spawnObj)),
    /produced no result/
  )
})

test("runEngine throws on timeout (killed child)", async () => {
  const spawnObj = fakeSpawn({ hang: true })
  await assert.rejects(
    () =>
      runEngine(
        { mode: "snapshot", url: "https://x/", options: {} },
        injected(spawnObj, { timeoutMs: 20 })
      ),
    /timed out/
  )
})

// ---- snapshotSite (build + SSRF pre-check + run) ---------------------------

test("snapshotSite blocks a private target before spawning", async () => {
  const cwd = realCwd()
  const spawnObj = fakeSpawn({ stdout: OK_ENVELOPE + "\n" })
  try {
    const env = await snapshotSite(
      { cwd, url: "http://127.0.0.1/", output: "o.html" },
      injected(spawnObj)
    )
    assert.equal(env.ok, false)
    assert.equal(env.error.reason, "private-host")
    assert.equal(spawnObj.calls.length, 0, "must not spawn for a blocked target")
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("snapshotSite runs the engine for an allowed target", async () => {
  const cwd = realCwd()
  const spawnObj = fakeSpawn({ stdout: OK_ENVELOPE + "\n" })
  try {
    const env = await snapshotSite(
      { cwd, url: "https://example.com/", output: "o.html", mode: "single" },
      injected(spawnObj)
    )
    assert.equal(env.ok, true)
    assert.equal(spawnObj.calls.length, 1)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("snapshotSite allows a private target when allowPrivateHosts is set", async () => {
  const cwd = realCwd()
  const spawnObj = fakeSpawn({ stdout: OK_ENVELOPE + "\n" })
  try {
    const env = await snapshotSite(
      { cwd, url: "http://127.0.0.1/", output: "o.html", allowPrivateHosts: true },
      injected(spawnObj)
    )
    assert.equal(env.ok, true)
    assert.equal(spawnObj.calls.length, 1)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
