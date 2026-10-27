import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { test } from "node:test"
import { NATIVE_AGENT_BRIDGES, stageNativeAgentBridges } from "./stage-native-agent-bridges.mjs"

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-agent-stage-test-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const [id, spec] of Object.entries(NATIVE_AGENT_BRIDGES)) {
    const file = path.join(root, spec.source)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, id === "codebuff"
      ? `if(process.argv[2]==="${spec.args[0]}"){globalThis.__bridgeReady=true; import("@codebuff/sdk").then(s=>console.log(s.ready))}`
      : `if(process.argv[2]==="${spec.args[0]}")console.log("${id}")`)
  }
  const sdk = path.join(root, "packages/agent-codebuff/node_modules/@codebuff/sdk")
  fs.mkdirSync(sdk, { recursive: true })
  fs.writeFileSync(path.join(sdk, "package.json"), JSON.stringify({ name: "@codebuff/sdk", version: "0.10.7", main: "index.cjs" }))
  fs.writeFileSync(path.join(sdk, "index.cjs"), 'exports.ready=globalThis.__bridgeReady && require("node:fs").readFileSync(__dirname+"/asset.wasm","utf8")')
  fs.writeFileSync(path.join(sdk, "asset.wasm"), "owned-asset")
  const sidecarOutDir = path.join(root, "output/sidecar")
  return { root, sidecarOutDir, sdk }
}

test("stages an isolated lazy SDK closure including assets and reproducible pins", (t) => {
  const args = fixture(t)
  const staged = stageNativeAgentBridges({ ...args, pin: true })
  assert.equal(staged.manifest.sdk.version, "0.10.7")
  assert.ok(staged.manifest.dependencyFiles["node_modules/@codebuff/sdk/asset.wasm"])
  assert.ok(staged.manifest.sources[NATIVE_AGENT_BRIDGES.codebuff.source])
  const executed = spawnSync(process.execPath, [path.join(staged.dir, "codebuff.cjs"), "--cognia-codebuff-bridge"], { cwd: os.tmpdir(), encoding: "utf8", env: {} })
  assert.equal(executed.status, 0, executed.stderr)
  assert.equal(executed.stdout.trim(), "owned-asset")
  const ordinary = stageNativeAgentBridges(args)
  assert.deepEqual(ordinary.manifest, staged.manifest)
})
test("ordinary staging refuses absent pins and source drift without replacing output", (t) => {
  const args = fixture(t)
  assert.throws(() => stageNativeAgentBridges(args), /pins missing/)
  const staged = stageNativeAgentBridges({ ...args, pin: true })
  const prior = fs.readFileSync(path.join(staged.dir, "codebuff.cjs"), "utf8")
  fs.appendFileSync(path.join(args.root, NATIVE_AGENT_BRIDGES.codebuff.source), '\nconsole.log("changed")')
  assert.throws(() => stageNativeAgentBridges(args), /differs from embedded pins/)
  assert.equal(fs.readFileSync(path.join(staged.dir, "codebuff.cjs"), "utf8"), prior)
})
test("ordinary staging refuses changed SDK files and a non-pinned installed version", (t) => {
  const args = fixture(t)
  stageNativeAgentBridges({ ...args, pin: true })
  fs.writeFileSync(path.join(args.sdk, "asset.wasm"), "changed")
  assert.throws(() => stageNativeAgentBridges(args), /dependency inventory/)
  fs.writeFileSync(path.join(args.sdk, "package.json"), JSON.stringify({ name: "@codebuff/sdk", version: "0.10.8" }))
  assert.throws(() => stageNativeAgentBridges({ ...args, pin: true }), /expected installed @codebuff\/sdk@0.10.7/)
})
test("refuses redirected entry sources and destination folders", (t) => {
  const args = fixture(t)
  const source = path.join(args.root, NATIVE_AGENT_BRIDGES.codebuff.source)
  fs.renameSync(source, source + ".original")
  fs.symlinkSync(source + ".original", source)
  assert.throws(() => stageNativeAgentBridges({ ...args, pin: true }), /source path escapes/)
  fs.unlinkSync(source)
  fs.renameSync(source + ".original", source)
  fs.mkdirSync(args.sidecarOutDir, { recursive: true })
  fs.symlinkSync(args.sdk, path.join(args.sidecarOutDir, "native-agents"), "dir")
  assert.throws(() => stageNativeAgentBridges({ ...args, pin: true }), /destination is a symlink/)
})


test("unchanged staging preserves watched files but repairs extra or tampered output", (t) => {
  const args = fixture(t)
  const staged = stageNativeAgentBridges({ ...args, pin: true })
  const entry = path.join(staged.dir, "codebuff.cjs")
  const before = fs.statSync(entry)
  const pins = path.join(args.root, "sidecar/native-agents/pins.json")
  const pinsBefore = fs.statSync(pins)
  stageNativeAgentBridges(args)
  assert.equal(fs.statSync(entry).ino, before.ino)
  assert.equal(fs.statSync(entry).mtimeMs, before.mtimeMs)
  assert.equal(fs.statSync(pins).mtimeMs, pinsBefore.mtimeMs)
  fs.writeFileSync(path.join(staged.dir, "unexpected.js"), "untrusted")
  fs.writeFileSync(entry, "tampered")
  stageNativeAgentBridges(args)
  assert.equal(fs.existsSync(path.join(staged.dir, "unexpected.js")), false)
  assert.match(fs.readFileSync(entry, "utf8"), /__bridgeReady/)
})
