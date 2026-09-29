import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import readline from "node:readline"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { resetStagingRoot, startLocalRuntime } from "./local-runtime.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const secret = "k".repeat(40)

async function tempRoot(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cognia-local-runtime-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const overlayPath = path.join(dir, "overlay.js")
  await fs.writeFile(overlayPath, "window.__overlay = true")
  return { dir, overlayPath, profilesRoot: path.join(dir, "browser", "profiles") }
}

function control(address, type, payload) {
  return fetch(`http://127.0.0.1:${address.port}/v1/control`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ version: 1, type, payload }),
  })
}

test("resetStagingRoot empties only the staging directory", async (t) => {
  const { dir } = await tempRoot(t)
  const staging = path.join(dir, ".download-staging")
  await fs.mkdir(path.join(staging, "nested"), { recursive: true })
  await fs.writeFile(path.join(staging, "guid-1"), "partial")
  await fs.writeFile(path.join(dir, "keep.txt"), "keep")
  await resetStagingRoot(staging)
  assert.deepEqual(await fs.readdir(staging), [])
  assert.equal(await fs.readFile(path.join(dir, "keep.txt"), "utf8"), "keep")
})

test("serves only the local-mode browser service on loopback", async (t) => {
  const { overlayPath, profilesRoot, dir } = await tempRoot(t)
  const runtime = await startLocalRuntime({
    config: {
      secret,
      profilesRoot,
      stagingRoot: path.join(dir, "browser", ".download-staging"),
      overlayPath,
      maxSessions: 2,
      maxPages: 4,
    },
    chromium: {},
  })
  t.after(() => runtime.close())
  assert.equal(runtime.address.address, "127.0.0.1")
  assert.equal(runtime.browserService.mode, "local")
  assert.equal(runtime.browserService.idleTimeoutMs, Number.POSITIVE_INFINITY)
  const health = await fetch(`http://127.0.0.1:${runtime.address.port}/v1/health`, {
    headers: { authorization: `Bearer ${secret}` },
  }).then((response) => response.json())
  assert.deepEqual(health, {
    version: 1,
    status: "ready",
    browser: "ready",
    supervisor: "absent",
    mode: "local",
  })
  const agent = await control(runtime.address, "agent.list", {})
  assert.equal(agent.status, 400)
  assert.equal((await agent.json()).code, "unknown_operation")
  await fs.stat(path.join(dir, "browser", ".download-staging"))
})

function spawnLocalMain(t) {
  const child = spawn(process.execPath, [path.join(here, "local-main.mjs")], {
    stdio: ["pipe", "pipe", "inherit"],
  })
  t.after(() => child.kill("SIGKILL"))
  const lines = readline.createInterface({ input: child.stdout })
  const firstLine = new Promise((resolve) => lines.once("line", resolve))
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)))
  return { child, firstLine, exited }
}

test("local-main reads the secret from stdin, prints ready, and exits on stdin EOF", async (t) => {
  const { overlayPath, profilesRoot } = await tempRoot(t)
  const { child, firstLine, exited } = spawnLocalMain(t)
  child.stdin.write(`${JSON.stringify({ secret, profilesRoot, overlayPath })}\n`)
  const ready = JSON.parse(await firstLine)
  assert.equal(ready.type, "ready")
  assert.equal(ready.mode, "local")
  assert.equal(ready.address.address, "127.0.0.1")
  assert.ok(ready.address.port > 0)
  const health = await fetch(`http://127.0.0.1:${ready.address.port}/v1/health`, {
    headers: { authorization: `Bearer ${secret}` },
  })
  assert.equal(health.status, 200)
  const denied = await fetch(`http://127.0.0.1:${ready.address.port}/v1/health`)
  assert.equal(denied.status, 401)
  child.stdin.end()
  assert.equal(await exited, 0)
})

test("local-main exits cleanly on SIGTERM", async (t) => {
  const { overlayPath, profilesRoot } = await tempRoot(t)
  const { child, firstLine, exited } = spawnLocalMain(t)
  child.stdin.write(`${JSON.stringify({ secret, profilesRoot, overlayPath })}\n`)
  assert.equal(JSON.parse(await firstLine).type, "ready")
  child.kill("SIGTERM")
  assert.equal(await exited, 0)
})

test("local-main reports an invalid config and exits 78", async (t) => {
  const { overlayPath, profilesRoot } = await tempRoot(t)
  const { child, firstLine, exited } = spawnLocalMain(t)
  child.stdin.write(`${JSON.stringify({ secret: "short", profilesRoot, overlayPath })}\n`)
  assert.deepEqual(JSON.parse(await firstLine), {
    type: "error",
    code: "config_invalid",
    message: "secret must be 32..1024 characters",
  })
  assert.equal(await exited, 78)
})

function injectSession(service, id, context) {
  const session = service.newSessionRecord({ id, kind: "local" })
  session.id = id
  session.context = context
  service.sessions.set(id, session)
  return session
}

test("close shuts every browser session concurrently before the listener and refuses new ones", async (t) => {
  const { overlayPath, profilesRoot, dir } = await tempRoot(t)
  const runtime = await startLocalRuntime({
    config: {
      secret,
      profilesRoot,
      stagingRoot: path.join(dir, "browser", ".download-staging"),
      overlayPath,
    },
    chromium: {},
  })
  const order = []
  let releaseHung
  const hung = new Promise((resolve) => {
    releaseHung = resolve
  })
  injectSession(runtime.browserService, "hung", {
    close: async () => {
      order.push("hung:closing")
      await hung
      order.push("hung:closed")
    },
  })
  injectSession(runtime.browserService, "quick", {
    close: async () => {
      order.push("quick:closed")
    },
  })
  const closing = runtime.close()
  await new Promise((resolve) => setTimeout(resolve, 20))
  // The hung browser does not keep the other one open.
  assert.deepEqual(order, ["hung:closing", "quick:closed"])
  // The listener is still up until every browser is closed, but refuses new sessions.
  const refused = await control(runtime.address, "browser.session.create", { id: "late" })
  assert.equal((await refused.json()).code, "browser_runtime_shutting_down")
  releaseHung()
  await closing
  assert.deepEqual(order, ["hung:closing", "quick:closed", "hung:closed"])
  assert.equal(runtime.browserService.sessions.size, 0)
  await assert.rejects(() =>
    fetch(`http://127.0.0.1:${runtime.address.port}/v1/health`, {
      headers: { authorization: `Bearer ${secret}` },
    })
  )
})

test("a launch that resolves after shutdown began is closed, not orphaned", async (t) => {
  const { overlayPath, profilesRoot, dir } = await tempRoot(t)
  let finishLaunch
  const closed = []
  const chromium = {
    launchPersistentContext: () =>
      new Promise((resolve) => {
        finishLaunch = () => resolve({ close: async () => closed.push("context") })
      }),
  }
  const runtime = await startLocalRuntime({
    config: {
      secret,
      profilesRoot,
      stagingRoot: path.join(dir, "browser", ".download-staging"),
      overlayPath,
    },
    chromium,
    serviceOptions: { defaultDownloadsDir: path.join(dir, "Downloads") },
  })
  const service = runtime.browserService
  const creating = service.createSession({ id: "s1", kind: "local" })
  while (!finishLaunch) await new Promise((resolve) => setImmediate(resolve))
  const closing = runtime.close()
  finishLaunch()
  await assert.rejects(creating, (error) => error.code === "browser_runtime_shutting_down")
  await closing
  // Closed by the launch's own cleanup (and possibly by closeSession too;
  // Playwright's close is idempotent). Never left open.
  assert.ok(closed.length >= 1)
  assert.equal(service.sessions.size, 0)
})

test("local-main exits when stdin closes right after the config line", async (t) => {
  const { overlayPath, profilesRoot } = await tempRoot(t)
  const { child, exited } = spawnLocalMain(t)
  child.stdin.end(`${JSON.stringify({ secret, profilesRoot, overlayPath })}\n`)
  assert.equal(await exited, 0)
})
