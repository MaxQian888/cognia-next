import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { withFailFastDev } from "./tauri.mjs"

const root = fileURLToPath(new URL("../..", import.meta.url))
const wrapperPath = fileURLToPath(new URL("./tauri.mjs", import.meta.url))

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

test(
  "stops beforeDevCommand after a watched Rust compilation failure",
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
      [wrapperPath, "dev", "--runner", runnerPath, "--config", configPath],
      {
        cwd: root,
        detached: true,
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
