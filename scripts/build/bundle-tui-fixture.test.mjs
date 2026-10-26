import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { ensureFixtureBundle } from "./bundle-tui-fixture.mjs"

test("real esbuild fixture tracks workspace inputs rather than unrelated test mtimes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pty-bundle-cache-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, "cli/src/tui/pty"), { recursive: true })
  fs.mkdirSync(path.join(root, "packages/agent/src"), { recursive: true })
  fs.writeFileSync(path.join(root, "tsconfig.build.json"), "{}")
  fs.writeFileSync(path.join(root, "tsconfig.json"), "{}")
  fs.writeFileSync(
    path.join(root, "cli/src/tui/pty/tui-app-fixture.tsx"),
    'import {value} from "../../../../packages/agent/src/value"; console.log(value)'
  )
  const source = path.join(root, "packages/agent/src/value.ts")
  fs.writeFileSync(source, 'export const value = "first"')
  const unrelated = path.join(root, "cli/src/tui/pty/screen.test.ts")
  fs.writeFileSync(unrelated, "// test")
  const execute = (entry) => execFileSync(process.execPath, [entry], { encoding: "utf8" }).trim()
  const first = await ensureFixtureBundle({ root })
  assert.equal(execute(first), "first")
  fs.writeFileSync(unrelated, "// edited test")
  assert.equal(await ensureFixtureBundle({ root }), first)
  const stat = fs.statSync(source)
  fs.writeFileSync(source, 'export const value = "second"')
  fs.utimesSync(source, stat.atime, stat.mtime)
  const second = await ensureFixtureBundle({ root })
  assert.notEqual(second, first)
  assert.equal(execute(second), "second")
  assert.equal(execute(first), "first")
  assert.equal(fs.existsSync(path.join(root, "cli/dist")), false)
})
