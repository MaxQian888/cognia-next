// `node --test scripts/build/stage-browser-runtime.test.mjs`
//
// The staged runtime is the only copy of the local browser service an
// installed app has. Its failure modes: shipping tests, missing the shared
// overlay or playwright-core (the supervisor then refuses to start), leaving a
// torn copy that looks complete, and re-copying 13 MB on every `pnpm dev`.

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import {
  REQUIRED_STAGED_ENTRIES,
  STAMP_FILE,
  planCopies,
  runtimeSourceFiles,
  stageBrowserRuntime,
} from "./stage-browser-runtime.mjs"

function write(file, contents = "") {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents)
}

/** A fake repo root with the runtime, the overlay and a pnpm-style link. */
function fakeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-browser-runtime-"))
  const runtime = path.join(root, "services", "workspace-runtime")
  write(path.join(runtime, "package.json"), '{"name":"@cognia/workspace-runtime","type":"module"}')
  write(path.join(runtime, "src", "local-main.mjs"), "import './local-runtime.mjs'\n")
  write(path.join(runtime, "src", "local-runtime.mjs"), "export {}\n")
  write(path.join(runtime, "src", "local-runtime.test.mjs"), "test\n")
  write(path.join(runtime, "src", "nested", "helper.mjs"), "export {}\n")
  write(path.join(runtime, "src", "notes.md"), "not code\n")
  write(path.join(root, "lib", "browser", "overlay.injected.js"), "window.__overlay = 1\n")

  const store = path.join(root, "node_modules", ".pnpm", "playwright-core@1.0.0", "node_modules", "playwright-core")
  write(path.join(store, "package.json"), '{"name":"playwright-core","version":"1.0.0"}')
  write(path.join(store, "cli.js"), "#!/usr/bin/env node\n")
  fs.chmodSync(path.join(store, "cli.js"), 0o755)
  write(path.join(store, "browsers.json"), '{"browsers":[]}')
  write(path.join(store, "lib", "coreBundle.js"), "module.exports = {}\n")
  fs.mkdirSync(path.join(runtime, "node_modules"), { recursive: true })
  fs.symlinkSync(store, path.join(runtime, "node_modules", "playwright-core"), "dir")
  return root
}

function listFiles(dir) {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(dir, path.join(entry.parentPath ?? entry.path, entry.name)).split(path.sep).join("/")
    )
    .sort()
}

test("runtime sources exclude tests and non-module files", () => {
  const root = fakeRoot()
  try {
    const runtime = path.join(root, "services", "workspace-runtime")
    const files = runtimeSourceFiles(runtime).map((file) =>
      path.relative(runtime, file).split(path.sep).join("/")
    )
    assert.deepEqual(files, ["src/local-main.mjs", "src/local-runtime.mjs", "src/nested/helper.mjs"])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("staging copies the runtime, the overlay and a dereferenced playwright-core", () => {
  const root = fakeRoot()
  try {
    const result = stageBrowserRuntime({ root })
    assert.equal(result.staged, true)
    const out = path.join(root, "src-tauri", "resources", "browser-runtime")
    assert.equal(result.outDir, out)
    assert.deepEqual(listFiles(out), [
      STAMP_FILE,
      "node_modules/playwright-core/browsers.json",
      "node_modules/playwright-core/cli.js",
      "node_modules/playwright-core/lib/coreBundle.js",
      "node_modules/playwright-core/package.json",
      "package.json",
      "src/local-main.mjs",
      "src/local-runtime.mjs",
      "src/nested/helper.mjs",
      "src/overlay.injected.js",
    ])
    for (const required of REQUIRED_STAGED_ENTRIES) {
      assert.ok(fs.existsSync(path.join(out, required)), required)
    }
    // A real directory, not a link back into the pnpm store.
    assert.equal(fs.lstatSync(path.join(out, "node_modules", "playwright-core")).isSymbolicLink(), false)
    assert.equal(
      fs.readFileSync(path.join(out, "src", "overlay.injected.js"), "utf8"),
      "window.__overlay = 1\n"
    )
    assert.equal(fs.statSync(path.join(out, "node_modules/playwright-core/cli.js")).mode & 0o111, 0o111)
    const stamp = JSON.parse(fs.readFileSync(path.join(out, STAMP_FILE), "utf8"))
    assert.equal(stamp.digest, result.digest)
    assert.ok(stamp.files.includes("src/local-main.mjs"))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("an unchanged tree is a no-op and a change restages", () => {
  const root = fakeRoot()
  try {
    const first = stageBrowserRuntime({ root })
    const second = stageBrowserRuntime({ root })
    assert.equal(second.staged, false)
    assert.equal(second.digest, first.digest)

    write(path.join(root, "services", "workspace-runtime", "src", "local-runtime.mjs"), "export const v = 2\n")
    const third = stageBrowserRuntime({ root })
    assert.equal(third.staged, true)
    assert.notEqual(third.digest, first.digest)
    assert.equal(
      fs.readFileSync(path.join(third.outDir, "src", "local-runtime.mjs"), "utf8"),
      "export const v = 2\n"
    )

    // A removed source disappears from the staged tree too.
    fs.rmSync(path.join(root, "services", "workspace-runtime", "src", "nested"), { recursive: true })
    const fourth = stageBrowserRuntime({ root })
    assert.equal(fourth.staged, true)
    assert.equal(fs.existsSync(path.join(fourth.outDir, "src", "nested")), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("a torn staged tree is restaged even with a matching stamp", () => {
  const root = fakeRoot()
  try {
    const first = stageBrowserRuntime({ root })
    fs.rmSync(path.join(first.outDir, "node_modules", "playwright-core", "cli.js"))
    const second = stageBrowserRuntime({ root })
    assert.equal(second.staged, true)
    assert.ok(fs.existsSync(path.join(first.outDir, "node_modules", "playwright-core", "cli.js")))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("missing inputs fail loudly", () => {
  const root = fakeRoot()
  try {
    fs.rmSync(path.join(root, "services", "workspace-runtime", "node_modules"), { recursive: true })
    assert.throws(() => planCopies({ root }), /playwright-core is not installed/)
    fs.rmSync(path.join(root, "lib", "browser", "overlay.injected.js"))
    assert.throws(() => planCopies({ root }), /overlay\.injected\.js is missing/)
    fs.rmSync(path.join(root, "services", "workspace-runtime", "src", "local-main.mjs"))
    assert.throws(() => planCopies({ root }), /local-main\.mjs is missing/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("the real checkout plans a complete runtime", () => {
  const copies = planCopies()
  const targets = new Set(copies.map((copy) => copy.to))
  for (const required of REQUIRED_STAGED_ENTRIES) {
    assert.ok(targets.has(required), required)
  }
  assert.ok(![...targets].some((target) => target.endsWith(".test.mjs")))
})
