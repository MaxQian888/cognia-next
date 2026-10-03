// The globals an extension runs with, through the real host: the web-platform
// ones every extension gets, and `fetch` / `WebSocket`, which follow the
// extension's network grants and go through the user's proxy.
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { join } from "node:path"
import { test } from "node:test"

import { activation, FIXTURES, startHost } from "./host-harness.mjs"

const ID = "cognia.sandbox-extension"
const PATH = join(FIXTURES, "sandbox-extension")
const NETWORK = ["http", "https", "node:http", "node:https"]
const WEBSOCKET = ["ws", "net", "tls", "node:net", "node:tls"]
const NO_PROXY_ENV = {
  HTTP_PROXY: undefined,
  HTTPS_PROXY: undefined,
  http_proxy: undefined,
  https_proxy: undefined,
  ALL_PROXY: undefined,
  all_proxy: undefined,
  NO_PROXY: undefined,
  no_proxy: undefined,
}

async function startSandbox({ grantedModules = [], env = NO_PROXY_ENV } = {}) {
  const commands = new Map()
  const host = startHost(
    ID,
    (method, params) => {
      if (method === "commands:register") {
        commands.set(params.command, params.token)
        return { registered: true }
      }
      return null
    },
    { env }
  )
  await host.request("extension:load", {
    extensionId: ID,
    extensionPath: PATH,
    main: "./extension.js",
    bundleFormat: "cjs",
    grantedModules,
  })
  await host.request("extension:activate", activation(ID, PATH))
  const run = (command, ...args) =>
    host.request("extension:call", { extensionId: ID, token: commands.get(command), payload: args })
  return { host, run }
}

/** A local server answering every request with what it was asked. */
async function listen(handler) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { server, port: server.address().port }
}

test("extensions get the web-platform globals, and `global` is the context's own", async () => {
  const { host, run } = await startSandbox()
  try {
    assert.deepEqual(await run("sandboxFixture.globals"), {
      missing: [],
      global: true,
      microtask: "ran",
      clone: { nested: [1, 2] },
      aborted: true,
      base64: "cognia",
      uuid: 36,
      now: "number",
    })
  } finally {
    host.stop()
  }
})

test("fetch is refused without network:fetch, and the refusal is logged", async () => {
  const { host, run } = await startSandbox()
  try {
    assert.deepEqual(await run("sandboxFixture.fetch", "http://127.0.0.1:9/"), {
      error:
        'fetch is not available to extension "cognia.sandbox-extension": it needs the network:fetch permission',
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.ok(host.stderr.some((line) => line.includes("WARN fetch is not available")))
  } finally {
    host.stop()
  }
})

test("fetch works with network:fetch", async () => {
  const { server, port } = await listen((request, response) => response.end(`hello ${request.url}`))
  const { host, run } = await startSandbox({ grantedModules: NETWORK })
  try {
    assert.deepEqual(await run("sandboxFixture.fetch", `http://127.0.0.1:${port}/ping`), {
      status: 200,
      body: "hello /ping",
    })
  } finally {
    host.stop()
    server.close()
  }
})

test("fetch goes through the proxy the host was started with", async () => {
  const seen = []
  const { server, port } = await listen((request, response) => {
    seen.push(request.url)
    response.end("via proxy")
  })
  const { host, run } = await startSandbox({
    grantedModules: NETWORK,
    env: { ...NO_PROXY_ENV, HTTP_PROXY: `http://127.0.0.1:${port}` },
  })
  try {
    assert.deepEqual(await run("sandboxFixture.fetch", "http://cognia.invalid/ping"), {
      status: 200,
      body: "via proxy",
    })
    // A proxy is asked for the absolute URL.
    assert.deepEqual(seen, ["http://cognia.invalid/ping"])
  } finally {
    host.stop()
    server.close()
  }
})

test("WebSocket is refused without network:websocket and works like the host's with it", async () => {
  const denied = await startSandbox()
  try {
    assert.deepEqual(await denied.run("sandboxFixture.websocket"), {
      error:
        'WebSocket is not available to extension "cognia.sandbox-extension": it needs the network:websocket permission',
    })
    assert.deepEqual(await denied.run("sandboxFixture.websocketCall"), {
      error: "Constructor WebSocket requires 'new'",
    })
  } finally {
    denied.host.stop()
  }
  const granted = await startSandbox({ grantedModules: [...NETWORK, ...WEBSOCKET] })
  try {
    assert.deepEqual(await granted.run("sandboxFixture.websocket"), { opened: true, constant: 1 })
  } finally {
    granted.host.stop()
  }
})
