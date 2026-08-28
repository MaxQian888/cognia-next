import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url))
const scriptPath = fileURLToPath(new URL("./web-headless.mjs", import.meta.url))

function run(args = [], env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
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

test("refuses to start when a required port is occupied", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cognia-web-headless-port-check-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(path.join(root, "lsof"), "#!/bin/sh\nprintf '4242\\n'\n")
  await writeFile(path.join(root, "pnpm"), "#!/bin/sh\nexit 99\n")
  await chmod(path.join(root, "lsof"), 0o755)
  await chmod(path.join(root, "pnpm"), 0o755)

  const result = await run([], { PATH: `${root}${path.delimiter}${process.env.PATH}` })

  assert.equal(result.code, 2, result.stderr)
  assert.equal(result.signal, null)
  assert.match(result.stderr, /port 3000.*pid 4242/i)
  assert.match(result.stderr, /port 27890.*pid 4242/i)
  assert.match(result.stderr, /--force/)
})

test(
  "--force terminates the exact listener before starting both services",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cognia-web-headless-force-"))
    const logPath = path.join(root, "processes.log")
    const blocker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    })
    t.after(() => {
      if (blocker.exitCode === null && blocker.signalCode === null) blocker.kill("SIGKILL")
      return rm(root, { recursive: true, force: true })
    })
    await writeFile(
      path.join(root, "lsof"),
      `#!/usr/bin/env node
const requestedPort = process.argv.find((arg) => arg.startsWith("tcp:"))
if (requestedPort === "tcp:3000") {
  try {
    process.kill(Number(process.env.COGNIA_DEV_BLOCKER_PID), 0)
    process.stdout.write(process.env.COGNIA_DEV_BLOCKER_PID + "\\n")
  } catch {}
}
`
    )
    await writeFile(path.join(root, "ss"), "#!/bin/sh\nexit 0\n")
    await writeFile(path.join(root, "fuser"), "#!/bin/sh\nexit 0\n")
    await writeFile(
      path.join(root, "pnpm"),
      `#!/usr/bin/env node
import fs from "node:fs"
const service = process.argv[2]
const log = (event) => fs.appendFileSync(process.env.COGNIA_DEV_PROCESS_LOG, event + "\\n")
log(service + ":started")
if (service === "dev:headless") {
  setTimeout(() => process.exit(7), 50)
} else {
  process.on("SIGTERM", () => {
    log(service + ":stopped")
    process.exit(0)
  })
  setInterval(() => {}, 1_000)
}
`
    )
    for (const name of ["lsof", "ss", "fuser", "pnpm"]) {
      await chmod(path.join(root, name), 0o755)
    }

    const result = await run(["--force"], {
      PATH: `${root}${path.delimiter}${process.env.PATH}`,
      COGNIA_DEV_BLOCKER_PID: String(blocker.pid),
      COGNIA_DEV_PROCESS_LOG: logPath,
      // The script generates the shared runtime secret before it spawns
      // anything; keep that write inside the test's own directory.
      COGNIA_DATA_DIR: root,
    })

    assert.equal(result.code, 7, result.stderr)
    assert.equal(result.signal, null)
    assert.match(result.stdout, /force-killed listener.*port 3000/i)
    assert.deepEqual((await readFile(logPath, "utf8")).trim().split("\n").sort(), [
      "dev:headless:started",
      "dev:started",
      "dev:stopped",
      "dev:workspace-runtime:started",
      "dev:workspace-runtime:stopped",
    ])
    assert.equal(blocker.exitCode, null)
    assert.equal(blocker.signalCode, "SIGKILL")
  }
)

test(
  "stops the web process when the headless process fails",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cognia-web-headless-"))
    const logPath = path.join(root, "processes.log")
    const pnpmPath = path.join(root, "pnpm")
    t.after(() => rm(root, { recursive: true, force: true }))
    for (const name of ["lsof", "ss", "fuser"]) {
      await writeFile(path.join(root, name), "#!/bin/sh\nexit 0\n")
      await chmod(path.join(root, name), 0o755)
    }
    await writeFile(
      pnpmPath,
      `#!/usr/bin/env node
import fs from "node:fs"
const service = process.argv[2]
const log = (event) => fs.appendFileSync(process.env.COGNIA_DEV_PROCESS_LOG, event + "\\n")
log(service + ":started")
if (service === "dev:headless") {
  setTimeout(() => process.exit(7), 50)
} else {
  process.on("SIGTERM", () => {
    log(service + ":stopped")
    process.exit(0)
  })
  setInterval(() => {}, 1_000)
}
`
    )
    await chmod(pnpmPath, 0o755)

    const result = await run([], {
      PATH: `${root}${path.delimiter}${process.env.PATH}`,
      COGNIA_DEV_PROCESS_LOG: logPath,
      COGNIA_DATA_DIR: root,
    })

    assert.equal(result.code, 7, result.stderr)
    assert.equal(result.signal, null)
    assert.deepEqual((await readFile(logPath, "utf8")).trim().split("\n").sort(), [
      "dev:headless:started",
      "dev:started",
      "dev:stopped",
      "dev:workspace-runtime:started",
      "dev:workspace-runtime:stopped",
    ])
  }
)

test("dev:web-headless starts both services and tears down the peer on exit", async () => {
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"))
  const command = packageJson.scripts["dev:web-headless"]

  assert.equal(command, "node scripts/dev/web-headless.mjs")

  const result = await run(["--dry-run"])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.signal, null)
  assert.deepEqual(JSON.parse(result.stdout), {
    killPeerOnExit: true,
    services: [
      { name: "web", command: "pnpm", args: ["dev"] },
      {
        name: "headless",
        command: "pnpm",
        args: ["dev:headless", "--browser-listener-port", "27891"],
      },
      { name: "workspace-runtime", command: "pnpm", args: ["dev:workspace-runtime"] },
    ],
  })
})

test("the remote browser's runtime is a service, not a manual extra step", async () => {
  // The Host compiled with `workspace-runtime-exec` and pointed at a loopback
  // runtime still shows an unhealthy browser plane if nothing is listening on
  // 27910. Starting it here is what makes `dev:web-headless` a complete
  // topology rather than three quarters of one.
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"))
  assert.equal(
    packageJson.scripts["dev:workspace-runtime"],
    "node scripts/dev/workspace-runtime.mjs"
  )

  const result = await run(["--dry-run"])
  const runtime = JSON.parse(result.stdout).services.find(
    ({ name }) => name === "workspace-runtime"
  )
  assert.deepEqual(runtime.args, ["dev:workspace-runtime"])

  // The port has to agree with the URL the Host is handed; they are derived
  // from the same constant, and this is the assertion that keeps them so.
  const script = await readFile(new URL("./workspace-runtime.mjs", import.meta.url), "utf8")
  assert.match(script, /export const DEFAULT_WORKSPACE_RUNTIME_PORT = 27_910/)
})

test("dev:web-headless opens the one port a browser tab can reach the Host on", async () => {
  // A tab can neither pin nor validate the Host's self-signed certificate, so
  // the HTTPS listener on 27890 is unreachable from the web client this script
  // starts. Without the plaintext loopback listener the two halves boot and
  // never meet.
  const result = await run(["--dry-run"])
  assert.equal(result.code, 0, result.stderr)
  const headless = JSON.parse(result.stdout).services.find(({ name }) => name === "headless")
  assert.deepEqual(headless.args.slice(1), ["--browser-listener-port", "27891"])

  // The port must agree with the Rust default and the browser-side probe, or
  // discovery looks in a place nothing is listening.
  const rust = await readFile(
    new URL("../../src-tauri/src/companion_api/browser_access.rs", import.meta.url),
    "utf8"
  )
  assert.match(rust, /pub const DEFAULT_BROWSER_PORT: u16 = 27891;/)
  const probe = await readFile(
    new URL("../../lib/connectivity/loopback-discovery.ts", import.meta.url),
    "utf8"
  )
  assert.match(probe, /export const DEFAULT_BROWSER_ACCESS_PORT = 27891/)
})
