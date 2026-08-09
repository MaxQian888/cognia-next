import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(new URL("./headless.mjs", import.meta.url))

function run(args = [], env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.once("error", reject)
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

async function waitForFile(target, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await access(target)
      return
    } catch (error) {
      if (error.code !== "ENOENT") throw error
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw new Error(`timed out waiting for ${target}`)
}

test("documents the renderer-free development entry point", async () => {
  const result = await run(["--help"])

  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /pnpm dev:headless/)
  assert.match(result.stdout, /does not start Next\.js or a Tauri WebView/i)
  assert.match(result.stdout, /--skip-build/)
  assert.match(result.stdout, /--check/)
  assert.match(result.stdout, /--local-debug/)
  assert.match(result.stdout, /pnpm --silent dev:headless token/)
})

test("dry-run prints a redacted launch plan without writing development state", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cognia-headless-plan-"))
  const dataDir = path.join(root, "data")
  t.after(() => rm(root, { recursive: true, force: true }))

  const result = await run(["--dry-run", "--data-dir", dataDir, "--port", "28900", "--gateway"], {
    COGNIA_MASTER_KEY: "a".repeat(64),
    ANTHROPIC_API_KEY: "sk-must-not-leak",
  })

  assert.equal(result.code, 0, result.stderr)
  assert.doesNotMatch(result.stdout, /sk-must-not-leak|a{64}/)
  const plan = JSON.parse(result.stdout)
  assert.equal(plan.mode, "dry-run")
  assert.equal(plan.dataDir, dataDir)
  assert.equal(plan.port, 28900)
  assert.equal(plan.gateway, true)
  assert.deepEqual(plan.launch.args, ["serve", "--port", "28900"])
  assert.equal(plan.launch.environment.COGNIA_MASTER_KEY, "<redacted>")
  await assert.rejects(access(dataDir), { code: "ENOENT" })
})

test("check mode accepts a complete renderer-free artifact set", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cognia-headless-check-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const artifact = async (name, executable = false) => {
    const target = path.join(root, name)
    await writeFile(target, executable ? "#!/bin/sh\nexit 0\n" : "fixture\n")
    if (executable) await chmod(target, 0o755)
    return target
  }
  const keyFile = path.join(root, "master.key")
  await writeFile(keyFile, `${"b".repeat(64)}\n`, { mode: 0o600 })
  const env = {
    COGNIA_MASTER_KEY: "",
    COGNIA_MASTER_KEY_FILE: keyFile,
    COGNIA_HEADLESS_SERVER_BIN: await artifact("cognia-server", true),
    COGNIA_BRAIN_ENTRY: await artifact("brain.mjs"),
    COGNIA_SIDECAR_SCRIPT: await artifact("sidecar.mjs"),
    COGNIA_MCP_SIDECAR_PATH: await artifact("mcp.mjs"),
    COGNIA_VSCODE_EXT_HOST_SCRIPT: await artifact("vscode-host.js"),
    COGNIA_CODE_SERVER_AGENT_VSIX: await artifact("agent.vsix"),
  }

  const result = await run(["--check", "--skip-build", "--data-dir", path.join(root, "data")], env)

  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /Headless development artifacts are ready/)
  assert.match(result.stdout, /Next\.js and Tauri WebView: not started/)
})

test("launch mode creates a persistent key and wires the full headless process", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cognia-headless-launch-"))
  const dataDir = path.join(root, "data")
  t.after(() => rm(root, { recursive: true, force: true }))
  const artifact = async (name, contents = "fixture\n", executable = false) => {
    const target = path.join(root, name)
    await writeFile(target, contents)
    if (executable) await chmod(target, 0o755)
    return target
  }
  const server = await artifact(
    "cognia-server",
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  args: process.argv.slice(2),
  env: Object.fromEntries([
    "COGNIA_BRAIN_ENTRY",
    "COGNIA_CODE_SERVER_AGENT_VSIX",
    "COGNIA_DATA_DIR",
    "COGNIA_EXEC_BACKEND",
    "COGNIA_GATEWAY",
    "COGNIA_MASTER_KEY_FILE",
    "COGNIA_MCP_SIDECAR_PATH",
    "COGNIA_SIDECAR_SCRIPT",
    "COGNIA_VSCODE_EXT_HOST_SCRIPT",
  ].map((key) => [key, process.env[key]])),
}) + "\\n")
`,
    true
  )
  const env = {
    COGNIA_MASTER_KEY: "",
    COGNIA_MASTER_KEY_FILE: "",
    COGNIA_HEADLESS_SERVER_BIN: server,
    COGNIA_BRAIN_ENTRY: await artifact("brain.mjs"),
    COGNIA_SIDECAR_SCRIPT: await artifact("sidecar.mjs"),
    COGNIA_MCP_SIDECAR_PATH: await artifact("mcp.mjs"),
    COGNIA_VSCODE_EXT_HOST_SCRIPT: await artifact("vscode-host.js"),
    COGNIA_CODE_SERVER_AGENT_VSIX: await artifact("agent.vsix"),
  }

  const result = await run(
    [
      "--skip-build",
      "--data-dir",
      dataDir,
      "--port",
      "28901",
      "--gateway",
      "--allow-remote-terminal",
    ],
    env
  )

  assert.equal(result.code, 0, result.stderr)
  const capture = JSON.parse(result.stdout.trim().split("\n").at(-1))
  assert.deepEqual(capture.args, ["serve", "--port", "28901", "--allow-remote-terminal"])
  assert.equal(capture.env.COGNIA_DATA_DIR, dataDir)
  assert.equal(capture.env.COGNIA_EXEC_BACKEND, "local-process")
  assert.equal(capture.env.COGNIA_GATEWAY, "1")
  assert.equal(capture.env.COGNIA_MASTER_KEY_FILE, path.join(dataDir, "master.key"))
  assert.equal(capture.env.COGNIA_BRAIN_ENTRY, env.COGNIA_BRAIN_ENTRY)
  assert.equal(capture.env.COGNIA_SIDECAR_SCRIPT, env.COGNIA_SIDECAR_SCRIPT)
  assert.equal(capture.env.COGNIA_MCP_SIDECAR_PATH, env.COGNIA_MCP_SIDECAR_PATH)
  assert.equal(capture.env.COGNIA_VSCODE_EXT_HOST_SCRIPT, env.COGNIA_VSCODE_EXT_HOST_SCRIPT)
  assert.equal(capture.env.COGNIA_CODE_SERVER_AGENT_VSIX, env.COGNIA_CODE_SERVER_AGENT_VSIX)
  assert.match((await readFile(path.join(dataDir, "master.key"), "utf8")).trim(), /^[a-f0-9]{64}$/)
})

test("refuses to create a new key beside an existing encrypted secret store", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cognia-headless-orphaned-store-"))
  const dataDir = path.join(root, "data")
  const storePath = path.join(dataDir, "cognia", "secret-store.enc")
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.dirname(storePath), { recursive: true })
  await writeFile(storePath, "encrypted-fixture")

  const artifact = async (name, executable = false) => {
    const target = path.join(root, name)
    await writeFile(target, executable ? "#!/bin/sh\nexit 0\n" : "fixture\n")
    if (executable) await chmod(target, 0o755)
    return target
  }
  const env = {
    COGNIA_MASTER_KEY: "",
    COGNIA_MASTER_KEY_FILE: "",
    COGNIA_HEADLESS_SERVER_BIN: await artifact("cognia-server", true),
    COGNIA_BRAIN_ENTRY: await artifact("brain.mjs"),
    COGNIA_SIDECAR_SCRIPT: await artifact("sidecar.mjs"),
    COGNIA_MCP_SIDECAR_PATH: await artifact("mcp.mjs"),
    COGNIA_VSCODE_EXT_HOST_SCRIPT: await artifact("vscode-host.js"),
    COGNIA_CODE_SERVER_AGENT_VSIX: await artifact("agent.vsix"),
  }

  const result = await run(["--skip-build", "--data-dir", dataDir], env)

  assert.equal(result.code, 3)
  assert.match(result.stderr, /refusing to create a new master key/i)
  assert.match(result.stderr, /secret-store\.enc/)
  await assert.rejects(access(path.join(dataDir, "master.key")), { code: "ENOENT" })
})

test("local debug launches loopback-only with an ephemeral Apifox environment", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cognia-headless-local-debug-"))
  const dataDir = path.join(root, "data")
  t.after(() => rm(root, { recursive: true, force: true }))
  const artifact = async (name, contents = "fixture\n", executable = false) => {
    const target = path.join(root, name)
    await writeFile(target, contents)
    if (executable) await chmod(target, 0o755)
    return target
  }
  const server = await artifact(
    "cognia-server",
    `#!/usr/bin/env node
import fs from "node:fs"
const environmentPath = process.env.COGNIA_APIFOX_ENV_PATH
const environment = JSON.parse(fs.readFileSync(environmentPath, "utf8"))
const variables = Object.fromEntries(environment.values.map(({ key, value }) => [key, value]))
process.stdout.write(JSON.stringify({
  args: process.argv.slice(2),
  tokenLength: process.env.COGNIA_LOCAL_DEBUG_TOKEN.length,
  profileTokenMatches: variables.serviceToken === process.env.COGNIA_LOCAL_DEBUG_TOKEN,
  baseUrl: variables.baseUrl,
  caCertPath: variables.caCertPath,
  publicUrl: process.env.COGNIA_PUBLIC_URL,
  environmentPath,
  environmentMode: fs.statSync(environmentPath).mode & 0o777,
}) + "\\n")
`,
    true
  )
  const env = {
    COGNIA_MASTER_KEY: "d".repeat(64),
    COGNIA_PUBLIC_URL: "https://remote.example.test",
    COGNIA_HEADLESS_SERVER_BIN: server,
    COGNIA_BRAIN_ENTRY: await artifact("brain.mjs"),
    COGNIA_SIDECAR_SCRIPT: await artifact("sidecar.mjs"),
    COGNIA_MCP_SIDECAR_PATH: await artifact("mcp.mjs"),
    COGNIA_VSCODE_EXT_HOST_SCRIPT: await artifact("vscode-host.js"),
    COGNIA_CODE_SERVER_AGENT_VSIX: await artifact("agent.vsix"),
  }

  const result = await run(
    ["--local-debug", "--skip-build", "--data-dir", dataDir, "--port", "28902"],
    env
  )

  assert.equal(result.code, 0, result.stderr)
  const capture = JSON.parse(result.stdout.trim().split("\n").at(-1))
  assert.deepEqual(capture.args, ["serve", "--port", "28902", "--bind-loopback"])
  assert.ok(capture.tokenLength >= 43)
  assert.equal(capture.profileTokenMatches, true)
  assert.equal(capture.baseUrl, "https://127.0.0.1:28902")
  assert.equal(capture.caCertPath, path.join(dataDir, "cognia", "companion", "tls.pem"))
  assert.equal(capture.publicUrl, "https://127.0.0.1:28902")
  assert.equal(capture.environmentMode, 0o600)
  assert.match(result.stdout, /Apifox environment:/)
  assert.match(result.stdout, /expires when this server process stops/i)
  await assert.rejects(access(capture.environmentPath), { code: "ENOENT" })
})

test("local debug removes its temporary environment after an interrupt", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cognia-headless-local-debug-signal-"))
  const dataDir = path.join(root, "data")
  t.after(() => rm(root, { recursive: true, force: true }))
  const artifact = async (name, contents = "fixture\n", executable = false) => {
    const target = path.join(root, name)
    await writeFile(target, contents)
    if (executable) await chmod(target, 0o755)
    return target
  }
  const server = await artifact(
    "cognia-server",
    `#!/usr/bin/env node
setInterval(() => {}, 1_000)
`,
    true
  )
  const environmentPath = path.join(
    dataDir,
    "apifox",
    "cognia-local-debug.postman_environment.json"
  )
  const child = spawn(
    process.execPath,
    [script, "--local-debug", "--skip-build", "--data-dir", dataDir],
    {
      env: {
        ...process.env,
        COGNIA_MASTER_KEY: "e".repeat(64),
        COGNIA_HEADLESS_SERVER_BIN: server,
        COGNIA_BRAIN_ENTRY: await artifact("brain.mjs"),
        COGNIA_SIDECAR_SCRIPT: await artifact("sidecar.mjs"),
        COGNIA_MCP_SIDECAR_PATH: await artifact("mcp.mjs"),
        COGNIA_VSCODE_EXT_HOST_SCRIPT: await artifact("vscode-host.js"),
        COGNIA_CODE_SERVER_AGENT_VSIX: await artifact("agent.vsix"),
      },
      stdio: ["ignore", "ignore", "ignore"],
    }
  )
  t.after(() => child.kill("SIGKILL"))

  await waitForFile(environmentPath)
  child.kill("SIGINT")
  await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
  })

  await assert.rejects(access(environmentPath), { code: "ENOENT" })
})

test("token action issues a loopback debug token without requiring agent artifacts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cognia-headless-token-"))
  const dataDir = path.join(root, "data")
  t.after(() => rm(root, { recursive: true, force: true }))
  const server = path.join(root, "cognia-server")
  await writeFile(
    server,
    `#!/usr/bin/env node
process.stdout.write("debug-service-token\\n")
process.stderr.write(JSON.stringify({
  args: process.argv.slice(2),
  dataDir: process.env.COGNIA_DATA_DIR,
  masterKeyFile: process.env.COGNIA_MASTER_KEY_FILE,
}) + "\\n")
`
  )
  await chmod(server, 0o755)

  const result = await run(["token", "--data-dir", dataDir], {
    COGNIA_MASTER_KEY: "",
    COGNIA_MASTER_KEY_FILE: "",
    COGNIA_HEADLESS_SERVER_BIN: server,
    COGNIA_BRAIN_ENTRY: path.join(root, "missing-brain.mjs"),
  })

  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout.trim().split("\n").at(-1), "debug-service-token")
  const capture = JSON.parse(result.stderr.trim().split("\n").at(-1))
  assert.deepEqual(capture.args, ["issue-service-token"])
  assert.equal(capture.dataDir, dataDir)
  assert.equal(capture.masterKeyFile, path.join(dataDir, "master.key"))
  assert.match((await readFile(path.join(dataDir, "master.key"), "utf8")).trim(), /^[a-f0-9]{64}$/)
})

test(
  "default launch builds every required headless artifact before starting",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cognia-headless-build-"))
    t.after(() => rm(root, { recursive: true, force: true }))
    const artifact = async (name, contents = "fixture\n", executable = false) => {
      const target = path.join(root, name)
      await writeFile(target, contents)
      if (executable) await chmod(target, 0o755)
      return target
    }
    const buildLog = path.join(root, "build.jsonl")
    const pnpm = await artifact(
      "pnpm",
      `#!/usr/bin/env node
import fs from "node:fs"
fs.appendFileSync(process.env.COGNIA_BUILD_LOG, JSON.stringify(process.argv.slice(2)) + "\\n")
`,
      true
    )
    const env = {
      COGNIA_BUILD_LOG: buildLog,
      COGNIA_HEADLESS_PNPM_BIN: pnpm,
      COGNIA_MASTER_KEY: "c".repeat(64),
      COGNIA_HEADLESS_SERVER_BIN: await artifact("cognia-server", "#!/bin/sh\nexit 0\n", true),
      COGNIA_BRAIN_ENTRY: await artifact("brain.mjs"),
      COGNIA_SIDECAR_SCRIPT: await artifact("sidecar.mjs"),
      COGNIA_MCP_SIDECAR_PATH: await artifact("mcp.mjs"),
      COGNIA_VSCODE_EXT_HOST_SCRIPT: await artifact("vscode-host.js"),
      COGNIA_CODE_SERVER_AGENT_VSIX: await artifact("agent.vsix"),
    }

    const result = await run(["--data-dir", path.join(root, "data")], env)

    assert.equal(result.code, 0, result.stderr)
    const commands = (await readFile(buildLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    assert.deepEqual(commands, [
      ["cli:external-host:build"],
      ["support:docs:build"],
      ["exec", "node", "scripts/build/build-cli.mjs"],
      ["exec", "node", "scripts/build/build-mcp-sidecar.mjs"],
      ["exec", "node", "scripts/build/build-vscode-ext-host-sidecar.mjs"],
      ["sidecar:codeserver-agent:build"],
      ["terminal-host:prepare:dev"],
    ])
  }
)
