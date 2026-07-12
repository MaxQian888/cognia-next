// Tests for the engine runner (job parsing + job execution). Imports the BUILT
// output. The convert path runs the real component extractor on a tiny local
// fixture (no network); the snapshot path is exercised via an SSRF-blocked URL
// so it fails fast without touching the network.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { readJob, runJob } from "../dist/runner.js"

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

test("readJob parses a job file and validates mode", () => {
  const dir = tmp("wc-readjob-")
  try {
    const jobPath = join(dir, "job.json")
    writeFileSync(
      jobPath,
      JSON.stringify({ mode: "snapshot", url: "https://example.com/", options: {} })
    )
    const job = readJob(["node", "runner.js", jobPath])
    assert.equal(job.mode, "snapshot")
    assert.equal(job.url, "https://example.com/")

    writeFileSync(jobPath, JSON.stringify({ mode: "bogus", options: {} }))
    assert.throws(() => readJob(["node", "runner.js", jobPath]), /Invalid job\.mode/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("runJob rejects snapshot without a url", async () => {
  const env = await runJob({ mode: "snapshot", options: { output: "/tmp/x.html" } })
  assert.equal(env.ok, false)
  assert.match(env.error.message, /requires a url/)
})

test("runJob(snapshot) fails fast on an SSRF-blocked target", async () => {
  const dir = tmp("wc-ssrf-")
  try {
    const env = await runJob({
      mode: "snapshot",
      url: "http://169.254.169.254/latest/meta-data/",
      options: {
        output: join(dir, "out.html"),
        mode: "single",
        maxAssets: 5,
        concurrency: 2,
        timeout: 3000,
        retryCount: 0,
        inline: true,
        pretty: false,
      },
    })
    assert.equal(env.ok, false)
    assert.equal(env.error.reason, "private-host")
    assert.equal(env.error.name, "FetchTargetBlockedError")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("runJob(convert) extracts components from a local bundle fixture", async () => {
  const fixture = tmp("wc-convert-in-")
  const out = tmp("wc-convert-out-")
  try {
    // Minimal bundle: an index.html with a semantic component + inline style/logic.
    writeFileSync(
      join(fixture, "index.html"),
      `<!doctype html><html><head><style>.card{color:red}</style></head>` +
        `<body><header class="card" data-component="Hero"><h1>Hi</h1>` +
        `<button onclick="alert(1)">Go</button></header>` +
        `<script>let count = 0; function inc(){ count++ }</script></body></html>`
    )
    const env = await runJob({
      mode: "convert",
      options: {
        convertLocal: fixture,
        output: out,
        mode: "bundle",
        maxAssets: 0,
        concurrency: 1,
        timeout: 1000,
        retryCount: 0,
        inline: false,
        pretty: false,
        extractComponents: true,
        extractLogic: true,
      },
    })
    assert.equal(env.ok, true, JSON.stringify(env))
    assert.equal(env.result.mode, "convert")
    assert.equal(env.result.output, out)
    assert.ok(Array.isArray(env.result.assets))
    // The extractor wrote a components/ directory with an index.json.
    const idx = readFileSync(join(out, "components", "index.json"), "utf8")
    assert.ok(idx.length > 0)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
    rmSync(out, { recursive: true, force: true })
  }
})
