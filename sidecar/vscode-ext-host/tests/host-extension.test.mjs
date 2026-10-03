// Spawns the real built host (`dist/host.js`) the way the Rust host does and
// drives it over its line-delimited JSON-RPC: the only test that runs an
// actual extension through `host.ts` and `extension-runner.ts`.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const HOST = join(here, "..", "dist", "host.js")
const FIXTURES = join(here, "fixtures")

/** One host process, with a renderer-side answerer for host → renderer requests. */
function startHost(extensionId, answer = () => null) {
  const child = spawn(process.execPath, [HOST, "--cognia-extension", extensionId], {
    env: { ...process.env, COGNIA_VSCODE_EXTENSION_ID: extensionId },
    stdio: ["pipe", "pipe", "pipe"],
  })
  const pending = new Map()
  const notifications = []
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
  child.stderr.resume()
  return {
    notifications,
    request(method, params) {
      const id = nextId++
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    },
    stop: () => child.kill(),
  }
}

function activation(extensionId, extensionPath, overrides = {}) {
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

test("an extension gets a real context, a semver vscode, mementos that persist, and gated modules", async () => {
  const id = "cognia.context-extension"
  const path = join(FIXTURES, "context-extension")
  const host = startHost(id)
  try {
    await host.request("extension:load", {
      extensionId: id,
      extensionPath: path,
      main: "./extension.js",
      bundleFormat: "cjs",
      grantedModules: ["fs"],
    })
    const params = activation(id, path)
    const { exportsSerializable: seen } = await host.request("extension:activate", params)
    assert.equal(seen.vscodeVersion, "1.91.0")
    assert.equal(seen.nestedVersion, "1.91.0")
    assert.equal(seen.extensionUri, `file://${path.split("/").map(encodeURIComponent).join("/")}`)
    assert.equal(seen.extensionPath, path)
    assert.equal(seen.packageName, "context-extension")
    assert.equal(seen.globalStorage, params.globalStoragePath)
    assert.equal(seen.storage, params.storagePath, "a path with a space survives the Uri")
    assert.equal(seen.mode, seen.productionMode)
    assert.equal(seen.activations, 3)
    assert.equal(seen.fs, "granted")
    assert.equal(seen.childProcess, "denied", "an ungranted sensitive module is refused")
    assert.equal(seen.hasLocation, true)
    const write = host.notifications.find((frame) => frame.method === "memento:write")
    assert.deepEqual(write.params, {
      extensionId: id,
      scope: "global",
      key: "activations",
      value: 3,
      deleted: false,
    })
  } finally {
    host.stop()
  }
})

test("no workspace folder: storageUri is undefined, as in VS Code", async () => {
  const id = "cognia.context-extension"
  const path = join(FIXTURES, "context-extension")
  const host = startHost(id)
  try {
    await host.request("extension:load", {
      extensionId: id,
      extensionPath: path,
      main: "./extension.js",
      bundleFormat: "cjs",
      grantedModules: [],
    })
    const { exportsSerializable: seen } = await host.request(
      "extension:activate",
      activation(id, path, { storagePath: null })
    )
    assert.equal(seen.storage, null)
    assert.equal(seen.fs, "denied")
  } finally {
    host.stop()
  }
})

test("the hello extension registers its command, which runs through extension:call", async () => {
  const id = "cognia.hello-extension"
  const path = join(FIXTURES, "hello-extension")
  const registered = []
  const host = startHost(id, (method, params) => {
    if (method === "commands:register") registered.push(params)
    return null
  })
  try {
    await host.request("extension:load", {
      extensionId: id,
      extensionPath: path,
      main: "./out/extension.js",
      bundleFormat: "cjs",
      grantedModules: [],
    })
    await host.request("extension:activate", activation(id, path))
    for (let i = 0; i < 50 && registered.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(registered[0]?.command, "hello.world")
    const result = await host.request("extension:call", {
      extensionId: id,
      token: registered[0].token,
      payload: [],
    })
    assert.equal(result, "Hello, world!")
  } finally {
    host.stop()
  }
})
