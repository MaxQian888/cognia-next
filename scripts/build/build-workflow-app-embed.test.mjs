import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { build } from "esbuild"
import { buildWorkflowAppEmbed } from "./build-workflow-app-embed.mjs"

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-embed-cache-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, "scripts/build"), { recursive: true })
  await writeFile(path.join(root, "scripts/build/helper.ts"), "export const value = 1")
  await writeFile(
    path.join(root, "scripts/build/cognia-workflow-app.ts"),
    'import {value} from "./helper"; globalThis.workflowValue = value'
  )
  let calls = 0
  return {
    root,
    output: path.join(root, "public/cognia-workflow-app.js"),
    calls: () => calls,
    run: () =>
      buildWorkflowAppEmbed({
        root,
        bundle: async (options) => {
          calls++
          return build(options)
        },
      }),
  }
}

test("workflow embed skips a verified unchanged build and preserves output mtime", async (t) => {
  const f = await fixture(t)
  assert.equal((await f.run()).cached, false)
  await utimes(f.output, 1000, 1000)
  assert.equal((await f.run()).cached, true)
  assert.equal(f.calls(), 1)
  assert.equal((await stat(f.output)).mtimeMs, 1000000)
  assert.match(
    await readFile(f.output, "utf8"),
    /^\/\/ Generated from scripts\/build\/cognia-workflow-app.ts;/
  )
})

test("workflow transitive source and lockfile changes invalidate; damaged output is repaired", async (t) => {
  const f = await fixture(t)
  await f.run()
  await writeFile(path.join(f.root, "scripts/build/helper.ts"), "export const value = 99")
  assert.equal((await f.run()).cached, false)
  assert.match(await readFile(f.output, "utf8"), /99/)
  await writeFile(path.join(f.root, "pnpm-lock.yaml"), "changed")
  assert.equal((await f.run()).cached, false)
  await writeFile(f.output, "tampered")
  assert.equal((await f.run()).cached, false)
  assert.match(await readFile(f.output, "utf8"), /99/)
  await rm(f.output)
  assert.equal((await f.run()).cached, false)
})

test("new dependencies are included in the next cache and failed builds retain the published output", async (t) => {
  const f = await fixture(t)
  await f.run()
  await writeFile(path.join(f.root, "scripts/build/other.ts"), "export const value = 2")
  await writeFile(path.join(f.root, "scripts/build/helper.ts"), 'export {value} from "./other"')
  await f.run()
  const before = f.calls()
  await writeFile(path.join(f.root, "scripts/build/other.ts"), "export const value = 3")
  await f.run()
  assert.equal(f.calls(), before + 1)
  const previous = await readFile(f.output, "utf8")
  await writeFile(path.join(f.root, "scripts/build/other.ts"), "broken source {{{")
  await assert.rejects(f.run(), /Build failed/)
  assert.equal(await readFile(f.output, "utf8"), previous)
})
