import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { resolveClaudeRuntime, stageClaudeRuntime } from "./stage-claude-runtime.mjs"

const SDK = "@anthropic-ai/claude-agent-sdk"
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-runtime-stage-")))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const owner = path.join(root, "sidecar/node_modules/.pnpm/sdk/node_modules")
  const sdk = path.join(owner, SDK)
  const name = `${SDK}-darwin-arm64`
  const runtime = path.join(owner, name)
  fs.mkdirSync(sdk, { recursive: true })
  fs.mkdirSync(runtime, { recursive: true })
  fs.writeFileSync(path.join(sdk, "package.json"), JSON.stringify({ optionalDependencies: { [name]: "1.2.3" } }))
  fs.writeFileSync(path.join(runtime, "package.json"), JSON.stringify({ name, version: "1.2.3" }))
  fs.writeFileSync(path.join(runtime, "claude"), "native fixture", { mode: 0o755 })
  fs.mkdirSync(path.join(root, "sidecar/node_modules/@anthropic-ai"), { recursive: true })
  fs.symlinkSync(sdk, path.join(root, "sidecar/node_modules", SDK), "dir")
  return { root, sdk, runtime, name, options: { root, packageName: name } }
}

test("stages pnpm's sibling optional package where the copied SDK can resolve it", (t) => {
  const { root, sdk, name, options } = fixture(t)
  const nodeModulesDir = path.join(root, "isolated/node_modules")
  const stagedSdk = path.join(nodeModulesDir, SDK)
  fs.cpSync(sdk, stagedSdk, { recursive: true })
  const require = createRequire(path.join(stagedSdk, "package.json"))
  assert.throws(() => require.resolve(`${name}/claude`), { code: "MODULE_NOT_FOUND" })
  const result = stageClaudeRuntime({ ...options, nodeModulesDir })
  assert.equal(require.resolve(`${name}/claude`), path.join(result.destination, "claude"))
  assert.equal(fs.readFileSync(require.resolve(`${name}/claude`), "utf8"), "native fixture")
  assert.ok(fs.statSync(require.resolve(`${name}/claude`)).mode & 0o111)
})

test("fails packaging when the target optional dependency is absent", (t) => {
  const { runtime, options } = fixture(t)
  fs.rmSync(runtime, { recursive: true })
  assert.throws(() => resolveClaudeRuntime(options), /Missing Claude runtime.*1\.2\.3/)
})

test("rejects mismatched versions and missing executables", (t) => {
  const { runtime, options } = fixture(t)
  fs.writeFileSync(path.join(runtime, "package.json"), JSON.stringify({ version: "9.0.0" }))
  assert.throws(() => resolveClaudeRuntime(options), /does not match SDK requirement/)
  fs.writeFileSync(path.join(runtime, "package.json"), JSON.stringify({ version: "1.2.3" }))
  fs.rmSync(path.join(runtime, "claude"))
  assert.throws(() => resolveClaudeRuntime(options), /Missing Claude executable/)
})

test("rejects an undeclared platform package", (t) => {
  const { root } = fixture(t)
  assert.throws(() => resolveClaudeRuntime({ root, platform: "win32", arch: "x64" }), /does not declare runtime/)
})

test("installed SDK resolves and executes its staged native runtime outside the repo", (t) => {
  const root = fileURLToPath(new URL("../../../", import.meta.url))
  const isolated = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-runtime-real-")))
  t.after(() => fs.rmSync(isolated, { recursive: true, force: true }))
  const nodeModulesDir = path.join(isolated, "node_modules")
  const sdk = path.join(nodeModulesDir, SDK)
  fs.cpSync(path.join(root, "sidecar/node_modules", SDK), sdk, { recursive: true, dereference: true })
  const runtime = stageClaudeRuntime({ root, nodeModulesDir })
  const require = createRequire(path.join(sdk, "sdk.mjs"))
  const binary = require.resolve(`${runtime.name}/${path.basename(runtime.binary)}`)
  assert.ok(binary.startsWith(isolated))
  const result = spawnSync(binary, ["--version"], {
    cwd: isolated,
    env: { PATH: process.env.PATH, HOME: isolated },
    encoding: "utf8",
    timeout: 15_000,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Claude Code/)
})
