import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url))
const scriptPath = fileURLToPath(new URL("./web-headless.mjs", import.meta.url))
const repoRoot = await realpath(fileURLToPath(new URL("../..", import.meta.url)))
const defaultWorkspacesDir = repoRoot

async function dryRun(args = [], env = {}) {
  const result = await run(["--dry-run", ...args], env)
  assert.equal(result.code, 0, result.stderr)
  return JSON.parse(result.stdout)
}

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
    assert.match(result.stdout, /may browse and run in/)
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
    workspacesDir: defaultWorkspacesDir,
    services: [
      { name: "web", command: "pnpm", args: ["dev"] },
      {
        name: "headless",
        command: "pnpm",
        args: [
          "dev:headless",
          "--browser-listener-port",
          "27891",
          "--workspaces-dir",
          defaultWorkspacesDir,
        ],
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
  assert.deepEqual(headless.args.slice(1, 3), ["--browser-listener-port", "27891"])

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

test("the Host is confined to the checkout, not the data dir and not its siblings", async () => {
  // Unset, the Host confines every paired client to `<data dir>/workspaces`,
  // which holds none of the code on this machine -- the server folder picker
  // then opens on a refusal. The point of this script is a browser tab driving
  // this machine's code, so the default root is the checkout.
  const { workspacesDir } = await dryRun()

  assert.equal(workspacesDir, defaultWorkspacesDir)
  // The checkout, not the folder that holds it. That folder is usually
  // `~/Projects`, and the Host refuses nothing inside the root it is given,
  // for running as well as for browsing, so every sibling repository would be
  // reachable by default. Widening to it is `--workspaces-dir ..`.
  assert.equal(workspacesDir, repoRoot)
  assert.notEqual(workspacesDir, await realpath(path.resolve(repoRoot, "..")))
})

test("--workspaces-dir narrows the root, and beats the environment", async (t) => {
  const flagRoot = await mkdtemp(path.join(os.tmpdir(), "cognia-web-headless-flag-"))
  const envRoot = await mkdtemp(path.join(os.tmpdir(), "cognia-web-headless-env-"))
  t.after(() =>
    Promise.all([flagRoot, envRoot].map((dir) => rm(dir, { recursive: true, force: true })))
  )

  const flagged = await dryRun(["--workspaces-dir", flagRoot], { COGNIA_WORKSPACES_DIR: envRoot })
  const headless = flagged.services.find(({ name }) => name === "headless")

  // Resolved through the real path, the way the Host resolves it: on macOS
  // the temp dir is a symlink, and the root the client is told about has to be
  // the root `fs_workspace_roots` reports back.
  assert.equal(flagged.workspacesDir, await realpath(flagRoot))
  assert.deepEqual(headless.args.slice(3), ["--workspaces-dir", await realpath(flagRoot)])
})

test("COGNIA_WORKSPACES_DIR is honoured when no flag is passed", async (t) => {
  const envRoot = await mkdtemp(path.join(os.tmpdir(), "cognia-web-headless-env-only-"))
  t.after(() => rm(envRoot, { recursive: true, force: true }))

  const { workspacesDir } = await dryRun([], { COGNIA_WORKSPACES_DIR: envRoot })

  assert.equal(workspacesDir, await realpath(envRoot))
})

test("a root that is not a usable directory is refused before anything starts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cognia-web-headless-bad-root-"))
  const filePath = path.join(root, "not-a-dir")
  await writeFile(filePath, "")
  t.after(() => rm(root, { recursive: true, force: true }))

  // The Host would boot happily and then refuse every browse with an opaque
  // error, because it reads this once at startup and never again.
  const missing = await run(["--dry-run", "--workspaces-dir", path.join(root, "nope")])
  assert.equal(missing.code, 4, missing.stderr)
  assert.match(missing.stderr, /workspaces dir does not exist/)

  const file = await run(["--dry-run", "--workspaces-dir", filePath])
  assert.equal(file.code, 4, file.stderr)
  assert.match(file.stderr, /workspaces dir is not a directory/)
})

test("a --workspaces-dir with no value is refused, not silently widened", async () => {
  // `argv[flagIndex + 1]` on its own resolved `<cwd>/--dry-run` as a path, and
  // a trailing flag fell through to the default root -- the opposite of the
  // narrowing the user asked for, with nothing said about it.
  const swallowed = await run(["--workspaces-dir", "--dry-run"])
  assert.equal(swallowed.code, 4, swallowed.stderr)
  assert.match(swallowed.stderr, /--workspaces-dir needs a directory path/)

  const trailing = await run(["--dry-run", "--workspaces-dir"])
  assert.equal(trailing.code, 4, trailing.stderr)
  assert.match(trailing.stderr, /--workspaces-dir needs a directory path/)
})
