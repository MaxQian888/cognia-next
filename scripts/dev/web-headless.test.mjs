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
    })

    assert.equal(result.code, 7, result.stderr)
    assert.equal(result.signal, null)
    assert.match(result.stdout, /force-killed listener.*port 3000/i)
    assert.deepEqual((await readFile(logPath, "utf8")).trim().split("\n").sort(), [
      "dev:headless:started",
      "dev:started",
      "dev:stopped",
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
    })

    assert.equal(result.code, 7, result.stderr)
    assert.equal(result.signal, null)
    assert.deepEqual((await readFile(logPath, "utf8")).trim().split("\n").sort(), [
      "dev:headless:started",
      "dev:started",
      "dev:stopped",
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
      { name: "headless", command: "pnpm", args: ["dev:headless"] },
    ],
  })
})
