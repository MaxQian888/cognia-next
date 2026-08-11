import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const entry = path.join(root, "cli/dist/cognia-agent.mjs")
const home = mkdtempSync(path.join(os.tmpdir(), "cognia-agent-rpc-smoke-"))
const hosts = new Set()

if (!existsSync(entry)) {
  throw new Error(`CLI bundle not found: ${entry}; run node scripts/build/build-cli.mjs first`)
}

function withTimeout(promise, message, timeoutMs = 10_000) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${message} after ${timeoutMs}ms`)), timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
}

function startHost() {
  const child = spawn(process.execPath, [entry, "rpc"], {
    cwd: root,
    env: { ...process.env, COGNIA_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  })
  const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const pending = new Map()
  let stderr = ""
  let nextId = 1
  let exitResult = null

  hosts.add(child)
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk) => {
    stderr += chunk
  })

  function failAll(error) {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    pending.clear()
  }

  const exited = new Promise((resolve, reject) => {
    child.once("error", (error) => {
      failAll(error)
      reject(error)
    })
    child.once("exit", (code, signal) => {
      exitResult = { code, signal }
      failAll(new Error(`RPC host exited: ${JSON.stringify(exitResult)}`))
      resolve(exitResult)
    })
  })

  stdout.on("line", (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      failAll(new Error(`host emitted non-JSON stdout: ${line}`))
      return
    }
    if (message.id === undefined) return
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    clearTimeout(waiter.timer)
    if (message.error) {
      waiter.reject(new Error(`RPC ${waiter.method} failed: ${JSON.stringify(message.error)}`))
    } else {
      waiter.resolve(message.result)
    }
  })

  function call(method, params = {}, timeoutMs = 10_000) {
    if (exitResult)
      return Promise.reject(new Error(`RPC host already exited: ${JSON.stringify(exitResult)}`))
    const id = nextId++
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`RPC ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      pending.set(id, { method, resolve, reject, timer })
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    return response
  }

  function notify(method, params = {}) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`)
  }

  async function initialize() {
    const result = await call("initialize", {
      client: { name: "agent-sdk-rpc-smoke", version: "0.1.0" },
      protocolVersions: [2],
      capabilities: [],
      limits: {},
    })
    if (result.protocolVersion !== 2) {
      throw new Error(`unexpected protocol version: ${result.protocolVersion}`)
    }
    for (const requiredMethod of ["initialize", "initialized", "runtime/status", "shutdown"]) {
      if (!result.methods.includes(requiredMethod)) {
        throw new Error(`host did not advertise ${requiredMethod}`)
      }
    }
    notify("initialized")
    return result
  }

  async function waitForExit(message) {
    return exitResult ?? withTimeout(exited, message)
  }

  function dispose() {
    hosts.delete(child)
    stdout.close()
    child.stdin.destroy()
  }

  return { child, call, initialize, waitForExit, dispose, diagnostics: () => stderr.trim() }
}

let activeHost
try {
  activeHost = startHost()
  await activeHost.initialize()
  const initialStatus = await activeHost.call("runtime/status")
  if (
    initialStatus.status !== "ready" ||
    initialStatus.openSessions !== 0 ||
    initialStatus.activeTurns !== 0
  ) {
    throw new Error(`unexpected initial runtime status: ${JSON.stringify(initialStatus)}`)
  }

  const created = await activeHost.call("session/create", { name: "crash-smoke" })
  const firstReceipt = await activeHost.call("session/tag", {
    sessionId: created.sessionId,
    tags: ["durable"],
    commandId: "crash-smoke-tag",
  })
  activeHost.child.kill("SIGKILL")
  const crashed = await activeHost.waitForExit("RPC host did not stop for crash simulation")
  if (crashed.signal === null && crashed.code === 0) {
    throw new Error(`crash simulation exited cleanly: ${JSON.stringify(crashed)}`)
  }
  activeHost.dispose()

  activeHost = startHost()
  await activeHost.initialize()
  await activeHost.call("session/open", { sessionId: created.sessionId })
  const recovered = await activeHost.call("session/state", { sessionId: created.sessionId })
  if (JSON.stringify(recovered.tags) !== JSON.stringify(["durable"])) {
    throw new Error(`session tags were not recovered: ${JSON.stringify(recovered)}`)
  }
  const duplicateReceipt = await activeHost.call("session/tag", {
    sessionId: created.sessionId,
    tags: ["must-not-replace-original"],
    commandId: "crash-smoke-tag",
  })
  if (JSON.stringify(duplicateReceipt) !== JSON.stringify(firstReceipt)) {
    throw new Error(
      `duplicate command receipt changed after restart: ${JSON.stringify(duplicateReceipt)}`
    )
  }
  const afterDuplicate = await activeHost.call("session/state", { sessionId: created.sessionId })
  if (JSON.stringify(afterDuplicate.tags) !== JSON.stringify(["durable"])) {
    throw new Error(`duplicate command re-applied side effects: ${JSON.stringify(afterDuplicate)}`)
  }

  const shutdown = await activeHost.call("shutdown")
  if (shutdown.ok !== true) {
    throw new Error(`unexpected shutdown result: ${JSON.stringify(shutdown)}`)
  }
  const exit = await activeHost.waitForExit("RPC host did not exit after shutdown")
  if (exit.code !== 0 || exit.signal !== null) {
    throw new Error(`RPC host exited abnormally: ${JSON.stringify(exit)}`)
  }
  activeHost.dispose()
  activeHost = undefined
  process.stdout.write("Agent SDK RPC handshake, crash recovery, and shutdown smoke passed\n")
} catch (error) {
  const detail = activeHost?.diagnostics()
  throw new Error(
    `${error instanceof Error ? error.message : String(error)}${detail ? `\nHost diagnostics:\n${detail}` : ""}`
  )
} finally {
  for (const child of hosts) child.kill("SIGKILL")
  activeHost?.dispose()
  rmSync(home, { recursive: true, force: true })
}
