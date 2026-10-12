import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  cargoPrepareScripts,
  devPrepareScripts,
  isDevLaunch,
  resolveBeforeDevCommand,
  withDefaultFeatures,
  withFailFastDev,
} from "./tauri.mjs"

const root = fileURLToPath(new URL("../..", import.meta.url))

async function reservePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  return port
}

async function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port })
    socket.setTimeout(500)
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    const unavailable = () => {
      socket.destroy()
      resolve(false)
    }
    socket.once("error", unavailable)
    socket.once("timeout", unavailable)
  })
}

test("adds fail-fast cleanup to watched Tauri development runs", () => {
  assert.deepEqual(withFailFastDev(["dev"]), ["dev", "--exit-on-panic"])
  assert.deepEqual(withFailFastDev(["dev", "--", "--profile", "dev-full"]), [
    "dev",
    "--exit-on-panic",
    "--",
    "--profile",
    "dev-full",
  ])
})

test("does not alter builds or duplicate explicit lifecycle options", () => {
  assert.deepEqual(withFailFastDev(["build", "--release"]), ["build", "--release"])
  assert.deepEqual(withFailFastDev(["dev", "--exit-on-panic"]), ["dev", "--exit-on-panic"])
  assert.deepEqual(withFailFastDev(["dev", "--no-watch"]), ["dev", "--no-watch"])
})

test("pnpm tauri dev uses the fail-fast wrapper", async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))

  assert.equal(packageJson.scripts.tauri, "node scripts/dev/tauri.mjs")
  assert.equal(packageJson.scripts["tauri:dev"], "node scripts/dev/tauri.mjs dev")
})

test("pnpm tauri:dev:nowatch keeps the frontend live but never restarts the app", async () => {
  // Other sessions edit Rust in this shared checkout; without `--no-watch` each
  // of their saves kills and rebuilds this app and resets the window to `/`.
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))
  assert.equal(
    packageJson.scripts["tauri:dev:nowatch"],
    "node scripts/dev/tauri.mjs dev --no-watch"
  )
  assert.deepEqual(withFailFastDev(["dev", "--no-watch"]), ["dev", "--no-watch"])
})

for (const entry of ["./tauri.mjs", "../build/run-tauri-system-node.mjs"])
  test(
    `${entry} stops beforeDevCommand after a watched Rust compilation failure`,
    { skip: process.platform === "win32", timeout: 15_000 },
    async (t) => {
      const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "cognia-tauri-lifecycle-"))
      const frontendPath = path.join(fixtureRoot, "frontend.mjs")
      const runnerPath = path.join(fixtureRoot, "runner.mjs")
      const configPath = path.join(fixtureRoot, "tauri.override.json")
      const port = await reservePort()
      let wrapper

      t.after(async () => {
        if (wrapper?.pid && wrapper.exitCode === null && wrapper.signalCode === null) {
          try {
            process.kill(-wrapper.pid, "SIGINT")
          } catch {}
        }
        await rm(fixtureRoot, { recursive: true, force: true })
      })

      await writeFile(
        frontendPath,
        `import http from "node:http"
const server = http.createServer((_request, response) => response.end("ready"))
server.listen(${port}, "127.0.0.1")
process.on("SIGTERM", () => server.close(() => process.exit(0)))
process.on("SIGINT", () => server.close(() => process.exit(0)))
`
      )
      await writeFile(
        runnerPath,
        `#!/usr/bin/env node
process.stderr.write("error: could not compile cognia-next due to 1 previous error\\n")
setTimeout(() => process.exit(101), 100)
`
      )
      await chmod(runnerPath, 0o755)
      await writeFile(
        configPath,
        `${JSON.stringify(
          {
            build: {
              beforeDevCommand: `node ${JSON.stringify(frontendPath)}`,
              devUrl: `http://127.0.0.1:${port}`,
            },
          },
          null,
          2
        )}\n`
      )

      wrapper = spawn(
        process.execPath,
        [
          fileURLToPath(new URL(entry, import.meta.url)),
          "dev",
          "--runner",
          runnerPath,
          "--config",
          configPath,
        ],
        {
          cwd: root,
          detached: true,
          // The wrapper warms the plugin-author CLI before a dev launch; the
          // fixture exercises the lifecycle only.
          env: { ...process.env, COGNIA_SKIP_CLI_BUILD: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        }
      )
      let output = ""
      wrapper.stdout.on("data", (chunk) => (output += chunk))
      wrapper.stderr.on("data", (chunk) => (output += chunk))
      const closed = new Promise((resolve, reject) => {
        wrapper.once("error", reject)
        wrapper.once("close", (code, signal) => resolve({ code, signal }))
      })

      const timeout = new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Tauri wrapper did not exit.\n${output}`)),
          10_000
        )
        timer.unref()
      })
      const result = await Promise.race([closed, timeout])

      assert.equal(result.code, 101, output)
      assert.equal(result.signal, null, output)
      assert.equal(await canConnect(port), false, output)
    }
  )

test("development entry points leave the bundle override to build.rs", async () => {
  // `src-tauri/build.rs` empties `bundle.resources` / `bundle.externalBin` for
  // every development build. `tauri-build` declares
  // `rerun-if-env-changed=TAURI_CONFIG`, so a launcher that exported its own
  // value would split its build-script fingerprint from rust-analyzer's and
  // `cargo test`'s and re-run the script (and recompile `app_lib`) on each
  // switch.
  for (const file of [
    "scripts/dev/tauri.mjs",
    "scripts/dev/headless.mjs",
    ".vscode/tasks.json",
    ".vscode/launch.json",
  ]) {
    const source = await readFile(path.join(root, file), "utf8")
    assert.doesNotMatch(source, /"TAURI_CONFIG"\s*:|TAURI_CONFIG:\s*[^\s]/, file)
  }
  const buildScript = await readFile(path.join(root, "src-tauri/build.rs"), "utf8")
  assert.match(buildScript, /\n {4}apply_dev_bundle_override\(\);\n\n {4}tauri_build::try_build/)
  assert.match(buildScript, /if !tauri_build::is_dev\(\) \{\n {8}return;/)
  assert.match(
    buildScript,
    /bundle\.insert\("resources"\.into\(\), serde_json::Value::Array\(Vec::new\(\)\)\)/
  )
  assert.match(
    buildScript,
    /bundle\.insert\("externalBin"\.into\(\), serde_json::Value::Array\(Vec::new\(\)\)\)/
  )
})

test("pre-builds only the cargo steps of beforeDevCommand", () => {
  const scripts = {
    "host:prepare:dev": "cargo build --bin host",
    "agent:prepare:dev": "cargo build --locked -p agent",
    "node:prepare": "node prepare.mjs",
    dev: "next dev",
  }

  assert.deepEqual(
    cargoPrepareScripts(
      "pnpm host:prepare:dev && pnpm run agent:prepare:dev && pnpm node:prepare && node free-port.mjs 3000 && pnpm dev",
      scripts
    ),
    ["host:prepare:dev", "agent:prepare:dev"]
  )
  assert.deepEqual(cargoPrepareScripts("pnpm missing && pnpm dev", scripts), [])
  assert.deepEqual(cargoPrepareScripts(undefined, scripts), [])
})

test("the desktop terminal host shares every cargo unit with tauri dev", async () => {
  // A second feature set on the same package compiles `app_lib`,
  // `cognia-companion` and their dependents twice per edit. The desktop dev
  // host builds the release sidecar's feature set; only the headless server
  // (ADR-0085) adds `workspace-runtime-exec`.
  //
  // Cargo keys units on the resolved feature set. `tauri dev` asks for the
  // defaults by name (`withDefaultFeatures`), which resolves to the same set as
  // a plain build, so every other dev build stays plain: spelling the defaults
  // out (`--no-default-features --features ocr-paddle`) is a different set.
  assert.deepEqual(withDefaultFeatures(["dev"]), ["dev", "--features", "default"])

  const { scripts } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))
  assert.equal(
    scripts["terminal-host:prepare:dev"],
    "cargo build --manifest-path src-tauri/Cargo.toml --bin cognia-server"
  )
  const launch = await readFile(path.join(root, ".vscode/launch.json"), "utf8")
  for (const block of launch.match(/"--bin",\s*"cognia-next",?[^\]]*\]/g) ?? []) {
    // A `tauri/custom-protocol` entry is a packaged-style build, not a dev one.
    if (block.includes("tauri/custom-protocol")) continue
    assert.doesNotMatch(block, /--no-default-features|"--features"/, block)
  }
  assert.equal(
    scripts["terminal-host:prepare:headless"],
    "cargo build --manifest-path src-tauri/Cargo.toml --bin cognia-server --features workspace-runtime-exec"
  )
  for (const name of ["external-agent-launcher:prepare:dev", "bootstrap-agent:prepare:dev"]) {
    assert.match(scripts[name], /^cargo build\b/, name)
  }
})

test("the real dev chain pre-builds every cargo helper ahead of the frontend wait", () => {
  const scripts = devPrepareScripts(["dev"], root)

  assert.ok(scripts.includes("terminal-host:prepare:dev"), scripts.join(", "))
  assert.deepEqual(devPrepareScripts(["dev", "--", "--profile", "dev-full"], root), scripts)
})

test("warms native helpers only for a dev launch", () => {
  assert.equal(isDevLaunch(["dev"]), true)
  assert.equal(isDevLaunch(["dev", "--", "--profile", "dev-full"]), true)
  // A `--help` after the separator belongs to cargo, not to the Tauri CLI.
  assert.equal(isDevLaunch(["dev", "--", "--help"]), true)
  assert.equal(isDevLaunch(["dev", "--help"]), false)
  assert.equal(isDevLaunch(["dev", "-h"]), false)
  assert.equal(isDevLaunch(["build"]), false)
  assert.equal(isDevLaunch([]), false)
})

test("skips the cargo pre-step outside watched dev runs", () => {
  assert.deepEqual(devPrepareScripts(["build"], root), [])
  assert.deepEqual(devPrepareScripts(["info"], root), [])
  assert.deepEqual(devPrepareScripts(["dev", "--help"], root), [])
})

test("follows --config overrides of beforeDevCommand", async (t) => {
  const base = { build: { beforeDevCommand: "pnpm host:prepare:dev && pnpm dev" } }

  assert.equal(resolveBeforeDevCommand(["dev"], base, root), base.build.beforeDevCommand)
  assert.equal(
    resolveBeforeDevCommand(
      ["dev", "--config", JSON.stringify({ build: { beforeDevCommand: "node a.mjs" } })],
      base,
      root
    ),
    "node a.mjs"
  )
  assert.equal(
    resolveBeforeDevCommand(
      [
        "dev",
        `--config=${JSON.stringify({ build: { beforeDevCommand: { script: "node b.mjs" } } })}`,
      ],
      base,
      root
    ),
    "node b.mjs"
  )
  assert.equal(
    resolveBeforeDevCommand(["dev", "-c", JSON.stringify({ app: {} })], base, root),
    base.build.beforeDevCommand
  )
  // Arguments after `--` belong to cargo, not the Tauri CLI.
  assert.equal(
    resolveBeforeDevCommand(["dev", "--", "--config", "x"], base, root),
    base.build.beforeDevCommand
  )

  const dir = await mkdtemp(path.join(os.tmpdir(), "cognia-tauri-config-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, "override.json")
  await writeFile(file, JSON.stringify({ build: { beforeDevCommand: "node c.mjs" } }))
  assert.equal(resolveBeforeDevCommand(["dev", "--config", file], base, root), "node c.mjs")

  // Formats the wrapper cannot read make it skip the pre-step rather than guess.
  assert.equal(resolveBeforeDevCommand(["dev", "--config", "override.toml"], base, root), null)
  assert.equal(resolveBeforeDevCommand(["dev", "--config"], base, root), null)
})

test("tauri dev asks for the default features by name, so it shares plain cargo's build", () => {
  assert.deepEqual(withDefaultFeatures(["dev"]), ["dev", "--features", "default"])
  assert.deepEqual(withDefaultFeatures(["dev", "--", "--profile", "dev-full"]), [
    "dev",
    "--features",
    "default",
    "--",
    "--profile",
    "dev-full",
  ])
  assert.deepEqual(withFailFastDev(withDefaultFeatures(["dev"])), [
    "dev",
    "--exit-on-panic",
    "--features",
    "default",
  ])
})

test("tauri dev keeps a caller's own default-feature choice", () => {
  const off = ["dev", "--", "--no-default-features", "--features", "ocr-tesseract"]
  assert.deepEqual(withDefaultFeatures(off), off)
  assert.deepEqual(withDefaultFeatures(["dev", "--features", "default"]), [
    "dev",
    "--features",
    "default",
  ])
  assert.deepEqual(withDefaultFeatures(["dev", "-f", "agent-debug,default"]), [
    "dev",
    "-f",
    "agent-debug,default",
  ])
  assert.deepEqual(withDefaultFeatures(["dev", "--features=default"]), [
    "dev",
    "--features=default",
  ])
  assert.deepEqual(withDefaultFeatures(["build", "--debug"]), ["build", "--debug"])
})
