import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { randomUUID } from "node:crypto"
import { ensureTestBundle } from "./test-bundle-cache.mjs"

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "test-bundle-cache-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, "packages/agent/src"), { recursive: true })
  const source = path.join(root, "packages/agent/src/value.ts")
  fs.writeFileSync(source, "one")
  const unrelated = path.join(root, "packages/agent/src/value.test.ts")
  fs.writeFileSync(unrelated, "test")
  let builds = 0
  const options = {
    root,
    kind: "pty",
    entryName: "fixture.mjs",
    key: "test",
    ownerPid: process.pid,
    async build(outdir) {
      builds++
      fs.mkdirSync(path.join(outdir, "chunks"), { recursive: true })
      fs.writeFileSync(
        path.join(outdir, "fixture.mjs"),
        'import { value } from "./chunks/value.mjs"; console.log(value)'
      )
      fs.writeFileSync(
        path.join(outdir, "chunks/value.mjs"),
        `export const value = ${JSON.stringify(fs.readFileSync(source, "utf8"))}`
      )
      fs.writeFileSync(path.join(outdir, "executable"), "tool", { mode: 0o755 })
      return { inputs: [source], extraFiles: [] }
    },
  }
  return { root, source, unrelated, options, builds: () => builds }
}

function execute(entry) {
  return spawnSync(process.execPath, [entry], { encoding: "utf8" }).stdout.trim()
}

test("reuses actual dependencies, ignores unrelated test edits, and detects same-mtime package changes", async (t) => {
  const f = fixture(t)
  const first = await ensureTestBundle(f.options)
  assert.equal(execute(first), "one")
  fs.writeFileSync(f.unrelated, "edited test")
  assert.equal(await ensureTestBundle(f.options), first)
  assert.equal(f.builds(), 1)
  const stat = fs.statSync(f.source)
  fs.writeFileSync(f.source, "two")
  fs.utimesSync(f.source, stat.atime, stat.mtime)
  const next = await ensureTestBundle(f.options)
  assert.notEqual(next, first)
  assert.equal(execute(next), "two")
  assert.equal(execute(first), "one", "an active reader retains the original generation")
})

for (const damage of ["chunk", "missing", "extra", "mode", "config", "key", "force"]) {
  test(`repairs or invalidates ${damage} without touching the previous reader`, async (t) => {
    const f = fixture(t)
    const first = await ensureTestBundle(f.options)
    const out = path.dirname(first)
    if (damage === "chunk") fs.appendFileSync(path.join(out, "chunks/value.mjs"), "// damage")
    if (damage === "missing") fs.rmSync(path.join(out, "chunks/value.mjs"))
    if (damage === "extra") fs.writeFileSync(path.join(out, "chunks/stale.mjs"), "old")
    if (damage === "mode") fs.chmodSync(path.join(out, "executable"), 0o644)
    if (damage === "config")
      fs.writeFileSync(path.join(f.root, "tsconfig.json"), '{"compilerOptions":{}}')
    const second = await ensureTestBundle({
      ...f.options,
      ...(damage === "key" ? { key: "different" } : {}),
      force: damage === "force",
    })
    assert.notEqual(first, second)
    assert.equal(execute(second), "one")
    assert.equal(f.builds(), 2)
  })
}

test("failed rebuild preserves the published generation and releases the build lock", async (t) => {
  const f = fixture(t)
  const first = await ensureTestBundle(f.options)
  await assert.rejects(
    ensureTestBundle({
      ...f.options,
      force: true,
      build: async () => {
        throw new Error("build failed")
      },
    }),
    /build failed/
  )
  assert.equal(await ensureTestBundle(f.options), first)
  assert.equal(execute(first), "one")
})

test("concurrent processes publish one build; dead readers are collected but unknown directories survive", async (t) => {
  const f = fixture(t)
  const lockParent = path.join(f.root, ".cache/jest/test-bundles-cli")
  fs.mkdirSync(path.join(lockParent, "lock"), { recursive: true })
  const dead = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" }).pid
  const deadToken = randomUUID()
  fs.writeFileSync(
    path.join(lockParent, "lock/owner.json"),
    JSON.stringify({ pid: dead, token: deadToken })
  )
  const script = path.join(f.root, "consumer.mjs")
  fs.writeFileSync(
    script,
    `
    import fs from "node:fs";
    import path from "node:path";
    import {ensureTestBundle} from ${JSON.stringify(new URL("./test-bundle-cache.mjs", import.meta.url).href)};
    const root = ${JSON.stringify(f.root)};
    const result = await ensureTestBundle({root,kind:"cli",entryName:"fixture.mjs",key:"test",ownerPid:process.pid,
      async build(out) {fs.appendFileSync(path.join(root,"count"),"build\\n"); await new Promise(r=>setTimeout(r,100)); fs.writeFileSync(path.join(out,"fixture.mjs"),"console.log('ok')"); return {inputs:[path.join(root,"packages/agent/src/value.ts")],extraFiles:[]};}
    });
    console.log(result);
  `
  )
  const run = () => {
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = "",
      stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    return once(child, "exit").then(([code]) => {
      assert.equal(code, 0, stderr)
      return stdout.trim()
    })
  }
  const paths = await Promise.all([run(), run(), run()])
  assert.equal(new Set(paths).size, 1)
  assert.ok(fs.existsSync(path.join(lockParent, `retired-${deadToken}/owner.json`)))
  assert.equal(fs.readFileSync(path.join(f.root, "count"), "utf8"), "build\n")
  const generations = path.resolve(path.dirname(paths[0]), "../..")
  const parent = path.dirname(generations)
  const unknown = path.join(parent, "unowned")
  fs.mkdirSync(unknown)
  fs.writeFileSync(path.join(unknown, "keep"), "safe")
  fs.writeFileSync(f.source, "changed")
  const next = await run()
  assert.notEqual(next, paths[0])
  assert.equal(fs.existsSync(generations), false)
  assert.equal(fs.readFileSync(path.join(unknown, "keep"), "utf8"), "safe")
})

test("runtime layout preserves CLI dependency, dev-checkout and backend resource paths", async (t) => {
  const f = fixture(t)
  fs.mkdirSync(path.join(f.root, "cli/node_modules/only-cli"), { recursive: true })
  fs.mkdirSync(path.join(f.root, "runtime/deepseek-harness"), { recursive: true })
  fs.writeFileSync(
    path.join(f.root, "cli/package.json"),
    JSON.stringify({ name: "fixture-cli", version: "1.2.3" })
  )
  fs.writeFileSync(
    path.join(f.root, "cli/node_modules/only-cli/package.json"),
    JSON.stringify({ name: "only-cli", main: "index.js" })
  )
  fs.writeFileSync(
    path.join(f.root, "cli/node_modules/only-cli/index.js"),
    "module.exports = 'cli-dependency'"
  )
  fs.writeFileSync(path.join(f.root, "runtime/deepseek-harness/marker"), "runtime")
  const entry = await ensureTestBundle({
    ...f.options,
    build: async (out) => {
      fs.mkdirSync(path.join(out, "chunks"))
      fs.writeFileSync(path.join(out, "fixture.mjs"), 'import "./chunks/check.mjs"')
      fs.writeFileSync(
        path.join(out, "chunks/check.mjs"),
        `
      import value from 'only-cli'; import fs from 'node:fs'; import path from 'node:path'; import {fileURLToPath} from 'node:url';
      const here=path.dirname(fileURLToPath(import.meta.url));
      const runtime=fs.readFileSync(path.resolve(here,'../../..','runtime/deepseek-harness/marker'),'utf8');
      const manifest=JSON.parse(fs.readFileSync(path.resolve(here,'../..','package.json'),'utf8'));
      console.log([value,runtime,manifest.name,here.includes('/cli/dist/')].join(':'));
    `
      )
      return { inputs: [f.source] }
    },
  })
  assert.equal(execute(entry), "cli-dependency:runtime:fixture-cli:true")
})

test("a manifest edited during layout preparation cannot certify an older copied manifest", async (t) => {
  const f = fixture(t)
  fs.mkdirSync(path.join(f.root, "cli"), { recursive: true })
  const manifest = path.join(f.root, "cli/package.json")
  fs.writeFileSync(manifest, JSON.stringify({ name: "old" }))
  let firstBuild = true
  const build = async (out) => {
    if (firstBuild) {
      firstBuild = false
      fs.writeFileSync(manifest, JSON.stringify({ name: "new" }))
      const future = new Date(Date.now() + 100)
      fs.utimesSync(manifest, future, future)
    }
    return f.options.build(out)
  }
  const first = await ensureTestBundle({ ...f.options, build })
  const second = await ensureTestBundle({ ...f.options, build })
  assert.notEqual(second, first)
  assert.equal(
    JSON.parse(fs.readFileSync(path.resolve(path.dirname(first), "../package.json"), "utf8")).name,
    "old"
  )
  assert.equal(
    JSON.parse(fs.readFileSync(path.resolve(path.dirname(second), "../package.json"), "utf8")).name,
    "new"
  )
})
