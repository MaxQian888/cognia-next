// Drives the real built host (`dist/host.js`) the way the Rust host does:
// line-delimited JSON-RPC on stdio, with the test answering the host's
// requests to the renderer.
import { spawn } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
export const HOST = join(here, "..", "dist", "host.js")
export const FIXTURES = join(here, "fixtures")

/** One host process, with a renderer-side answerer for host → renderer requests. */
export function startHost(extensionId, answer = () => null) {
  const child = spawn(process.execPath, [HOST, "--cognia-extension", extensionId], {
    env: { ...process.env, COGNIA_VSCODE_EXTENSION_ID: extensionId },
    stdio: ["pipe", "pipe", "pipe"],
  })
  const pending = new Map()
  const notifications = []
  const stderr = []
  let nextId = 1
  createInterface({ input: child.stdout }).on("line", (line) => {
    const frame = JSON.parse(line)
    if (frame.method && frame.id !== undefined) {
      Promise.resolve(answer(frame.method, frame.params)).then((result) =>
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result })}\n`)
      )
    } else if (frame.method) {
      notifications.push(frame)
    } else {
      const settle = pending.get(frame.id)
      pending.delete(frame.id)
      if (frame.error) settle?.reject(Object.assign(new Error(frame.error.message), frame.error))
      else settle?.resolve(frame.result)
    }
  })
  createInterface({ input: child.stderr }).on("line", (line) => stderr.push(line))
  return {
    notifications,
    stderr,
    request(method, params) {
      const id = nextId++
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    },
    stop: () => child.kill(),
  }
}

/** `extension:activate` parameters with fresh storage directories. */
export function activation(extensionId, extensionPath, overrides = {}) {
  const state = mkdtempSync(join(tmpdir(), "vscode-state-"))
  return {
    extensionId,
    extensionPath,
    globalStoragePath: join(state, "global"),
    storagePath: join(state, "workspace dir"),
    logPath: join(state, "log"),
    extensionMode: "production",
    initialGlobalState: { activations: 2 },
    initialWorkspaceState: {},
    ...overrides,
  }
}
