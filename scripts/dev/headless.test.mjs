import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createCipheriv } from "node:crypto"
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
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

async function writeEncryptedSecretStore(
  dataDir,
  keyHex,
  entries = { "service\0account": "secret" }
) {
  const nonce = Buffer.alloc(12, 7)
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), nonce)
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(entries)),
    cipher.final(),
    cipher.getAuthTag(),
  ])
  const storePath = path.join(dataDir, "cognia", "secret-store.enc")
  await mkdir(path.dirname(storePath), { recursive: true })
  await writeFile(storePath, Buffer.concat([nonce, ciphertext]), { mode: 0o600 })
  return storePath
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
  assert.match(result.stdout, /pnpm --silent dev:headless pair --device-name browser/)
  assert.match(result.stdout, /pnpm --silent dev:headless browser-enroll --skip-build/)
  // The two codes are not interchangeable, so the help must not describe them
  // with one word: `pair` is the app's pair screen, `browser-enroll` is the
  // extension.
  assert.match(result.stdout, /cgnp3 pairing invitation/)
  assert.match(result.stdout, /mint a cgnb1/)
  assert.match(result.stdout, /enrollment for the browser extension/)
})

test("pair action issues a browser invitation from the active headless data directory", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cognia-headless-pair-"))
  const dataDir = path.join(root, "data")
  t.after(() => rm(root, { recursive: true, force: true }))
  const server = path.join(root, "cognia-server")
  await writeFile(
    server,
    `#!/usr/bin/env node
process.stdout.write("cgnp3|fixture-invitation\\n")
process.stderr.write(JSON.stringify({
  args: process.argv.slice(2),
  dataDir: process.env.COGNIA_DATA_DIR,
  hasMasterKey: Boolean(process.env.COGNIA_MASTER_KEY),
}) + "\\n")
`
  )
  await chmod(server, 0o755)

  const result = await run(
    [
      "pair",
      "--skip-build",
      "--data-dir",
      dataDir,
      "--device-name",
      "browser",
      "--advertise-url",
      "https://cognia.example.com",
      "--tenant-id",
      "tenant-a",
      "--port",
      "28902",
    ],
    {
      COGNIA_HEADLESS_SERVER_BIN: server,
      COGNIA_MASTER_KEY: "a".repeat(64),
    }
  )

  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /cgnp3\|fixture-invitation/)
  const capture = JSON.parse(result.stderr)
  assert.deepEqual(capture.args, [
    "pair",
    "--device-name",
    "browser",
    "--advertise-url",
    "https://cognia.example.com",
    "--port",
    "28902",
    "--tenant-id",
    "tenant-a",
  ])
  assert.equal(capture.dataDir, dataDir)
  assert.equal(capture.hasMasterKey, true)
})

test("pair action rejects a stale server that emits a cgnp2 invitation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cognia-headless-pair-v2-"))
  const server = path.join(root, "cognia-server")
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(server, "#!/bin/sh\nprintf 'cgnp2|legacy-invitation\\n'\n")
  await chmod(server, 0o755)

  const result = await run(["pair", "--skip-build", "--data-dir", path.join(root, "data")], {
    COGNIA_HEADLESS_SERVER_BIN: server,
    COGNIA_MASTER_KEY: "a".repeat(64),
  })

  assert.equal(result.code, 3)
  assert.equal(result.stdout, "")
  assert.match(result.stderr, /expected a cgnp3 invitation/i)
  assert.match(result.stderr, /rebuild or redeploy/i)
})

test(
  "pair action rebuilds the native server before issuing an invitation",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cognia-headless-pair-build-"))
    const buildLog = path.join(root, "build.jsonl")
    const pnpm = path.join(root, "pnpm")
    const targetDir = path.join(root, "target")
    const server = path.join(targetDir, "debug", "cognia-server")
    t.after(() => rm(root, { recursive: true, force: true }))
    await mkdir(path.dirname(server), { recursive: true })
    await writeFile(
      pnpm,
      `#!/usr/bin/env node
import fs from "node:fs"
fs.appendFileSync(
  process.env.COGNIA_BUILD_LOG,
  JSON.stringify({ args: process.argv.slice(2), tauriConfig: process.env.TAURI_CONFIG ?? null }) +
    "\\n"
)
`
    )
    await writeFile(server, "#!/bin/sh\nprintf 'cgnp3|fresh-invitation\\n'\n")
    await chmod(pnpm, 0o755)
    await chmod(server, 0o755)

    const result = await run(["pair", "--data-dir", path.join(root, "data")], {
      COGNIA_BUILD_LOG: buildLog,
      COGNIA_HEADLESS_PNPM_BIN: pnpm,
      COGNIA_MASTER_KEY: "a".repeat(64),
      CARGO_TARGET_DIR: targetDir,
    })

    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /cgnp3\|fresh-invitation/)
    assert.deepEqual(JSON.parse((await readFile(buildLog, "utf8")).trim()), {
      args: ["terminal-host:prepare:dev"],
      // The pairing rebuild compiles the same headless binary, so it skips the
      // multi-gigabyte tauri resource staging for the same reason the serve
      // build does.
      tauriConfig: '{"bundle":{"resources":[]}}',
    })
  }
)

/**
 * The frozen `cgnb1|` vector.
 *
 * `packages/companion-client/src/browser-enrollment-payload.test.ts` asserts
 * that its own encoder produces this exact string for the same issue, and its
 * decoder reads it back. Two encoders exist — one here, one in the package the
 * extension bundles — and this literal is the only thing that keeps them equal.
 * A year-2100 expiry so the freshness check below never dates the fixture out.
 */
const BROWSER_ENROLLMENT_VECTOR =
  "cgnb1|eyJiYXNlIjoiaHR0cDovLzEyNy4wLjAuMToyNzg5MSIsInRlbmFudCI6InRlbmFudC1hIiwiZW5yb2xsbWVudCI6IjlmMWMuYWEyMiIsImV4cCI6NDEwMjQ0NDgwMDAwMH0"

const BROWSER_ENROLLMENT_ISSUE = {
  enrollment: "9f1c.aa22",
  expiresAtMs: 4_102_444_800_000,
  baseUrl: "http://127.0.0.1:27891",
  tenantId: "tenant-a",
}

async function browserEnrollmentServer(root, body, { exitCode = 0, stderr = "" } = {}) {
  const server = path.join(root, "cognia-server")
  await writeFile(
    server,
    `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(body)})
process.stderr.write(JSON.stringify({
  args: process.argv.slice(2),
  dataDir: process.env.COGNIA_DATA_DIR,
  hasMasterKey: Boolean(process.env.COGNIA_MASTER_KEY),
}) + "\\n")
process.stderr.write(${JSON.stringify(stderr)})
process.exitCode = ${exitCode}
`
  )
  await chmod(server, 0o755)
  return server
}

test("browser-enroll action encodes the native issue into a cgnb1 code", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cognia-headless-browser-enroll-"))
  const dataDir = path.join(root, "data")
  t.after(() => rm(root, { recursive: true, force: true }))
  const server = await browserEnrollmentServer(
    root,
    `${JSON.stringify(BROWSER_ENROLLMENT_ISSUE)}\n`
  )

  const result = await run(
    [
      "browser-enroll",
      "--skip-build",
      "--data-dir",
      dataDir,
      "--browser-listener-port",
      "27891",
      "--tenant-id",
      "tenant-a",
    ],
    { COGNIA_HEADLESS_SERVER_BIN: server, COGNIA_MASTER_KEY: "a".repeat(64) }
  )

  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, `${BROWSER_ENROLLMENT_VECTOR}\n`)
  const capture = JSON.parse(result.stderr.split("\n")[0])
  assert.deepEqual(capture.args, [
    "devices",
    "enroll-browser",
    "--browser-listener-port",
    "27891",
    "--tenant-id",
    "tenant-a",
  ])
  assert.equal(capture.dataDir, dataDir)
  assert.equal(capture.hasMasterKey, true)
  // Minting the code is only half the door; the extension's own origin has to
  // be allowed or every request it makes answers 403.
  assert.match(result.stderr, /chrome-extension:\/\/<id> in COGNIA_ALLOWED_WEB_ORIGINS/)
})

test("browser-enroll action lets the native command pick the conventional port", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cognia-headless-browser-default-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const server = await browserEnrollmentServer(root, JSON.stringify(BROWSER_ENROLLMENT_ISSUE))

  const result = await run(
    ["browser-enroll", "--skip-build", "--data-dir", path.join(root, "data")],
    {
      COGNIA_HEADLESS_SERVER_BIN: server,
      COGNIA_MASTER_KEY: "a".repeat(64),
    }
  )

  assert.equal(result.code, 0, result.stderr)
  // No flags invented here: the default lives in the native command, next to
  // the listener it has to match.
  assert.deepEqual(JSON.parse(result.stderr.split("\n")[0]).args, ["devices", "enroll-browser"])
})

test("browser-enroll action refuses an issue it cannot turn into a usable code", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cognia-headless-browser-bad-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const env = { COGNIA_MASTER_KEY: "a".repeat(64) }

  for (const [name, body, expected] of [
    // A binary that predates the subcommand, or one that printed prose.
    ["stale", "Pair invitation for device\n", /did not return JSON.*rebuild or redeploy/s],
    [
      "partial",
      JSON.stringify({ ...BROWSER_ENROLLMENT_ISSUE, enrollment: "" }),
      /omitted enrollment/,
    ],
    [
      "https",
      JSON.stringify({ ...BROWSER_ENROLLMENT_ISSUE, baseUrl: "https://127.0.0.1:27890" }),
      /which a browser extension cannot use/,
    ],
    [
      "off-machine",
      JSON.stringify({ ...BROWSER_ENROLLMENT_ISSUE, baseUrl: "http://10.0.0.4:27891" }),
      /which a browser extension cannot use/,
    ],
  ]) {
    const dir = path.join(root, name)
    await mkdir(dir, { recursive: true })
    const server = await browserEnrollmentServer(dir, body)
    const result = await run(
      ["browser-enroll", "--skip-build", "--data-dir", path.join(dir, "data")],
      { ...env, COGNIA_HEADLESS_SERVER_BIN: server }
    )
    assert.equal(result.code, 3, `${name}: ${result.stderr}`)
    assert.equal(result.stdout, "", name)
    assert.match(result.stderr, expected, name)
  }
})

test("browser-enroll action forwards the native refusal instead of only an exit code", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cognia-headless-browser-refusal-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  // What the native command says when the loopback listener is not bound —
  // the diagnosis the operator needs, and the reason stderr is forwarded
  // before the exit code is examined.
  const server = await browserEnrollmentServer(root, "", {
    exitCode: 1,
    stderr: "Error: the browser listener is not reachable at http://127.0.0.1:27891\n",
  })

  const result = await run(
    ["browser-enroll", "--skip-build", "--data-dir", path.join(root, "data")],
    { COGNIA_HEADLESS_SERVER_BIN: server, COGNIA_MASTER_KEY: "a".repeat(64) }
  )

  assert.equal(result.code, 3)
  assert.match(
    result.stderr,
    /the browser listener is not reachable at http:\/\/127\.0\.0\.1:27891/
  )
  assert.match(result.stderr, /browser enrollment issuer failed with exit code 1/)
})

test("browser-enroll action refuses flags that belong to the other pairing code", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cognia-headless-browser-flags-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const env = { COGNIA_MASTER_KEY: "a".repeat(64) }

  for (const flags of [
    // A browser device names itself at registration time.
    ["--device-name", "browser"],
    // The enrollment always advertises the loopback listener; an advertised
    // URL here would silently do nothing.
    ["--advertise-url", "https://cognia.example.com"],
    ["--gateway"],
  ]) {
    const result = await run(
      ["browser-enroll", "--data-dir", path.join(root, "data"), ...flags],
      env
    )
    assert.equal(result.code, 2, result.stderr)
    assert.match(result.stderr, /browser-enroll accepts --data-dir, --browser-listener-port/)
  }
})

test("the headless compile stages no tauri bundle resources, and no other build step is affected", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cognia-headless-build-env-"))
  const dataDir = path.join(root, "data")
  const buildLog = path.join(root, "build.jsonl")
  const pnpm = path.join(root, "pnpm")
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(
    pnpm,
    `#!/usr/bin/env node
import fs from "node:fs"
fs.appendFileSync(
  process.env.COGNIA_BUILD_LOG,
  JSON.stringify({ args: process.argv.slice(2), tauriConfig: process.env.TAURI_CONFIG ?? null }) +
    "\\n"
)
`
  )
  await chmod(pnpm, 0o755)
  const artifact = async (name, contents = "fixture\n", executable = false) => {
    const target = path.join(root, name)
    await writeFile(target, contents)
    if (executable) await chmod(target, 0o755)
    return target
  }

  const result = await run(["--data-dir", dataDir, "--port", "28902"], {
    COGNIA_BUILD_LOG: buildLog,
    COGNIA_HEADLESS_PNPM_BIN: pnpm,
    COGNIA_MASTER_KEY: "",
    COGNIA_MASTER_KEY_FILE: "",
    COGNIA_HEADLESS_SERVER_BIN: await artifact("cognia-server", "#!/bin/sh\nexit 0\n", true),
    COGNIA_BRAIN_ENTRY: await artifact("brain.mjs"),
    COGNIA_SIDECAR_SCRIPT: await artifact("sidecar.mjs"),
    COGNIA_MCP_SIDECAR_PATH: await artifact("mcp.mjs"),
    COGNIA_VSCODE_EXT_HOST_SCRIPT: await artifact("vscode-host.js"),
    COGNIA_CODE_SERVER_AGENT_VSIX: await artifact("agent.vsix"),
  })

  assert.equal(result.code, 0, result.stderr)
  const steps = (await readFile(buildLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  assert.deepEqual(
    steps.map((step) => step.args),
    [
      ["cli:native-hosts:build"],
      ["support:docs:build"],
      ["exec", "node", "scripts/build/build-cli.mjs"],
      ["exec", "node", "scripts/build/build-mcp-sidecar.mjs"],
      ["exec", "node", "scripts/build/build-vscode-ext-host-sidecar.mjs"],
      ["sidecar:codeserver-agent:build"],
      ["terminal-host:prepare:dev"],
    ]
  )
  // Only the cargo step reads TAURI_CONFIG, and only it may be overridden:
  // leaking the empty resource list into any other step would be a silent
  // configuration change for builds that do need the bundle.
  assert.deepEqual(
    steps.map((step) => step.tauriConfig),
    [null, null, null, null, null, null, '{"bundle":{"resources":[]}}']
  )
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

test("--workspaces-dir is what a client is allowed to browse, and serve owns it", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cognia-headless-roots-"))
  const dataDir = path.join(root, "data")
  const workspaces = path.join(root, "elsewhere")
  t.after(() => rm(root, { recursive: true, force: true }))
  const env = { COGNIA_MASTER_KEY: "a".repeat(64) }

  // Unset, the Host confines clients to <data dir>/workspaces and the variable
  // is simply absent rather than pinned to a guess.
  const fallback = await run(["--dry-run", "--data-dir", dataDir, "--port", "28900"], env)
  assert.equal(fallback.code, 0, fallback.stderr)
  assert.equal(JSON.parse(fallback.stdout).launch.environment.COGNIA_WORKSPACES_DIR, undefined)

  const pinned = await run(
    ["--dry-run", "--data-dir", dataDir, "--port", "28900", "--workspaces-dir", workspaces],
    env
  )
  assert.equal(pinned.code, 0, pinned.stderr)
  assert.equal(JSON.parse(pinned.stdout).launch.environment.COGNIA_WORKSPACES_DIR, workspaces)

  // The other actions do not launch a server, so accepting the flag there would
  // silently do nothing.
  const onToken = await run(["token", "--data-dir", dataDir, "--workspaces-dir", workspaces], env)
  assert.equal(onToken.code, 2, onToken.stdout)
  assert.match(onToken.stderr, /token only accepts --data-dir/)
})

test("the browser listener is off unless a port is named, and forwarded when it is", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cognia-headless-browser-"))
  const dataDir = path.join(root, "data")
  t.after(() => rm(root, { recursive: true, force: true }))
  const env = { COGNIA_MASTER_KEY: "a".repeat(64) }

  // Off by default: `dev:headless` alone starts no browser, so it should not
  // open a plaintext port on behalf of one.
  const off = await run(["--dry-run", "--data-dir", dataDir, "--port", "28900"], env)
  assert.equal(off.code, 0, off.stderr)
  assert.deepEqual(JSON.parse(off.stdout).launch.args, ["serve", "--port", "28900"])

  const on = await run(
    ["--dry-run", "--data-dir", dataDir, "--port", "28900", "--browser-listener-port", "27891"],
    env
  )
  assert.equal(on.code, 0, on.stderr)
  const plan = JSON.parse(on.stdout)
  assert.deepEqual(plan.launch.args, [
    "serve",
    "--port",
    "28900",
    "--browser-listener-port",
    "27891",
  ])
  // The listener refuses to bind without an allowlist, so the launch plan must
  // already carry the development origins.
  assert.equal(
    plan.launch.environment.COGNIA_ALLOWED_WEB_ORIGINS,
    "http://localhost:3000,http://127.0.0.1:3000"
  )
})

test("the browser listener port is rejected for actions that never bind one", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cognia-headless-browser-usage-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const env = { COGNIA_MASTER_KEY: "a".repeat(64) }

  for (const [action, expected] of [
    ["pair", /pair accepts/],
    ["token", /token only accepts --data-dir/],
  ]) {
    const result = await run(
      [action, "--data-dir", path.join(root, "data"), "--browser-listener-port", "27891"],
      env
    )
    assert.equal(result.code, 2, result.stderr)
    assert.match(result.stderr, expected)
  }

  const invalid = await run(
    ["--dry-run", "--data-dir", path.join(root, "data"), "--browser-listener-port", "0"],
    env
  )
  assert.equal(invalid.code, 2, invalid.stderr)
  assert.match(invalid.stderr, /--browser-listener-port must be an integer between 1 and 65535/)
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
    "COGNIA_ALLOWED_WEB_ORIGINS",
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
  assert.equal(
    capture.env.COGNIA_ALLOWED_WEB_ORIGINS,
    "http://localhost:3000,http://127.0.0.1:3000"
  )
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

test("rejects an existing master key that cannot decrypt the secret store", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cognia-headless-mismatched-key-"))
  const dataDir = path.join(root, "data")
  const keyFile = path.join(dataDir, "master.key")
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeEncryptedSecretStore(dataDir, "a".repeat(64))
  await writeFile(keyFile, `${"b".repeat(64)}\n`, { mode: 0o600 })

  const artifact = async (name, executable = false) => {
    const target = path.join(root, name)
    await writeFile(target, executable ? "#!/bin/sh\nexit 0\n" : "fixture\n")
    if (executable) await chmod(target, 0o755)
    return target
  }
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

  const result = await run(["--check", "--skip-build", "--data-dir", dataDir], env)

  assert.equal(result.code, 3)
  assert.match(result.stderr, /master key cannot decrypt/i)
  assert.match(result.stderr, /--recover-secret-store/)
  assert.equal((await readFile(path.join(dataDir, "cognia", "secret-store.enc"))).length > 0, true)
})

test("recovery preserves a mismatched secret store before starting empty", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cognia-headless-recover-store-"))
  const dataDir = path.join(root, "data")
  const keyFile = path.join(dataDir, "master.key")
  t.after(() => rm(root, { recursive: true, force: true }))
  const storePath = await writeEncryptedSecretStore(dataDir, "a".repeat(64))
  const originalStore = await readFile(storePath)
  await writeFile(keyFile, `${"b".repeat(64)}\n`, { mode: 0o600 })

  const artifact = async (name, executable = false) => {
    const target = path.join(root, name)
    await writeFile(target, executable ? "#!/bin/sh\nexit 0\n" : "fixture\n")
    if (executable) await chmod(target, 0o755)
    return target
  }
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

  const result = await run(["--recover-secret-store", "--skip-build", "--data-dir", dataDir], env)

  assert.equal(result.code, 0, result.stderr)
  await assert.rejects(access(storePath), { code: "ENOENT" })
  const preservedName = (await readdir(path.dirname(storePath))).find((name) =>
    name.startsWith("secret-store.enc.unreadable-")
  )
  assert.ok(preservedName)
  assert.deepEqual(await readFile(path.join(path.dirname(storePath), preservedName)), originalStore)
  assert.match(result.stderr, /preserved unreadable secret store/i)
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
      ["cli:native-hosts:build"],
      ["support:docs:build"],
      ["exec", "node", "scripts/build/build-cli.mjs"],
      ["exec", "node", "scripts/build/build-mcp-sidecar.mjs"],
      ["exec", "node", "scripts/build/build-vscode-ext-host-sidecar.mjs"],
      ["sidecar:codeserver-agent:build"],
      ["terminal-host:prepare:dev"],
    ])
  }
)
