import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, test } from "node:test"

import {
  defaultConcurrency,
  discoverSidecarSuites,
  isExcludedPath,
  isLiveSuite,
  parseArgs,
} from "./run-sidecar-tests.mjs"

const root = mkdtempSync(join(tmpdir(), "sidecar-suites-"))
after(() => rmSync(root, { recursive: true, force: true }))
for (const file of [
  "sidecar/a.test.mjs",
  "sidecar/x/b.test.ts",
  "sidecar/x/helper.mjs",
  "sidecar/dispatch/c.live.test.mjs",
  "sidecar/webclone/d.test.mjs",
  "sidecar/vscode-ext-host/tests/e.test.mjs",
  "sidecar/src/tools/builtin/webclone/f.test.ts",
  "sidecar/node_modules/pkg/g.test.mjs",
  "sidecar/builtin-tools/node_modules/h.test.mjs",
  "lib/outside.test.mjs",
]) {
  mkdirSync(join(root, dirname(file)), { recursive: true })
  writeFileSync(join(root, file), "")
}

test("discovers the sidecar's own unit suites, .mjs and .ts, sorted", () => {
  assert.deepEqual(discoverSidecarSuites({ root }), [
    "sidecar/a.test.mjs",
    "sidecar/src/tools/builtin/webclone/f.test.ts",
    "sidecar/x/b.test.ts",
  ])
})

test("--live selects only the live suites", () => {
  assert.deepEqual(discoverSidecarSuites({ root, live: true }), [
    "sidecar/dispatch/c.live.test.mjs",
  ])
})

test("nested packages are excluded only at the sidecar top level; node_modules everywhere", () => {
  assert.equal(isExcludedPath("sidecar/webclone/src/x.test.mjs"), true)
  assert.equal(isExcludedPath("sidecar/codeserver-agent-ext/tests/x.test.mjs"), true)
  assert.equal(isExcludedPath("sidecar/src/tools/builtin/webclone/run.test.ts"), false)
  assert.equal(isExcludedPath("sidecar/dispatch/node_modules/x.test.mjs"), true)
  assert.equal(isLiveSuite("sidecar/dispatch/x.spike.live.test.mjs"), true)
  assert.equal(isLiveSuite("sidecar/dispatch/live-harness.test.mjs"), false)
})

test("the real tree includes the run-code suites no folder glob used to name", () => {
  const suites = discoverSidecarSuites()
  assert.ok(suites.includes("sidecar/src/tools/builtin/run-code/supervisor.test.ts"))
  assert.ok(suites.includes("sidecar/pi-extension/cognia-pi-extension.test.ts"))
  assert.ok(!suites.some(isLiveSuite), "live suites stay out of the unit sweep")
})

test("concurrency: an explicit positive override wins, else half the cores capped at 4", () => {
  assert.equal(defaultConcurrency({ SIDECAR_TEST_CONCURRENCY: "7" }, 16), 7)
  assert.equal(defaultConcurrency({ SIDECAR_TEST_CONCURRENCY: "0" }, 16), 4)
  assert.equal(defaultConcurrency({ SIDECAR_TEST_CONCURRENCY: "x" }, 6), 3)
  assert.equal(defaultConcurrency({}, 1), 1)
})

test("parseArgs takes --live and repo-relative paths, and rejects unknown options", () => {
  assert.deepEqual(parseArgs(["--live"], "/repo", "/repo"), { live: true, files: [] })
  assert.deepEqual(parseArgs(["dispatch/a.test.mjs"], "/repo", "/repo/sidecar"), {
    live: false,
    files: ["sidecar/dispatch/a.test.mjs"],
  })
  assert.throws(() => parseArgs(["--watch"], "/repo", "/repo"), /unknown option --watch/)
})
