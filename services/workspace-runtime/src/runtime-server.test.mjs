import assert from "node:assert/strict"
import test from "node:test"

import { createRuntimeServer } from "./runtime-server.mjs"

function serviceStub() {
  return {
    createSession: async ({ id }) => ({ id, pages: [], activePageId: null }),
    closeSession: async () => {},
    navigate: async () => {},
    snapshot: async () => ({ generation: 1, url: "about:blank", title: "", nodes: [] }),
    act: async () => ({ ok: true, error: null, generation: 1 }),
    pressKey: async () => ({ ok: true, error: null, generation: 1 }),
    scroll: async () => ({ ok: true, error: null, generation: 1 }),
    evaluate: async () => ({ ok: true, value: null }),
    readConsole: async () => [],
    readNetwork: async () => [],
    back: async () => {},
    forward: async () => {},
    reload: async () => {},
    stop: async () => {},
    getPage: async () => ({ url: "about:blank", title: "" }),
    listPages: async () => [],
    createPage: async (_sessionId, url) => ({ id: "page-2", url, title: "", active: true }),
    activatePage: async () => {},
    closePage: async () => {},
    drag: async () => ({ ok: true, error: null, generation: 1 }),
    handleDialog: async () => ({ ok: true, error: null, generation: 1 }),
    waitForText: async () => ({ ok: true, timedOut: false }),
    waitForSelector: async () => ({ ok: true, timedOut: false }),
    waitForNetworkIdle: async () => ({ ok: true, timedOut: false }),
    waitForLoad: async () => ({ ok: true, timedOut: false }),
    screenshot: async () => ({ bytes: "", width: 1, height: 1, capturedAt: 0 }),
    setFiles: async () => {},
    listDownloads: () => [],
    startScreencast: async (_sessionId, onFrame) => {
      await onFrame(Buffer.from([1, 2, 3]))
    },
    ackScreencastFrame: async () => true,
    dispatchInput: async () => {},
    closeAll: async () => {},
  }
}

function supervisorStub() {
  return {
    spawn: async ({ id }) => ({ id, state: "running" }),
    send: async () => {},
    kill: async () => {},
    killAll: async () => {},
    status: (id) => ({ id, state: "running" }),
    list: () => [],
  }
}

async function fixture(t, browserService = serviceStub()) {
  const runtime = createRuntimeServer({
    secret: "x".repeat(32),
    browserService,
    supervisor: supervisorStub(),
  })
  const address = await runtime.listen(0, "127.0.0.1")
  t.after(() => runtime.close())
  return `http://127.0.0.1:${address.port}`
}

test("dispatches new page, drag, dialog, and scoped screenshot operations", async (t) => {
  const calls = []
  const browser = serviceStub()
  browser.createPage = async (...args) => {
    calls.push(["createPage", ...args])
    return { id: "page-2", url: args[1], title: "", active: true }
  }
  browser.drag = async (...args) => {
    calls.push(["drag", ...args])
    return { ok: true, error: null, generation: 1 }
  }
  browser.handleDialog = async (...args) => {
    calls.push(["handleDialog", ...args])
    return { ok: true, error: null, generation: 1 }
  }
  browser.screenshot = async (...args) => {
    calls.push(["screenshot", ...args])
    return { bytes: "", width: 1, height: 1, capturedAt: 0 }
  }
  const baseUrl = await fixture(t, browser)
  const headers = {
    authorization: `Bearer ${"x".repeat(32)}`,
    "content-type": "application/json",
  }
  const control = (type, payload) =>
    fetch(`${baseUrl}/v1/control`, {
      method: "POST",
      headers,
      body: JSON.stringify({ version: 1, type, payload }),
    })
  await control("browser.page.create", { sessionId: "session-1", url: "https://example.com" })
  await control("browser.drag", { sessionId: "session-1", sourceRef: "a", targetRef: "b" })
  await control("browser.dialog.handle", { sessionId: "session-1", accept: false })
  await control("browser.screenshot", {
    sessionId: "session-1",
    options: { scope: "element", ref: "b" },
  })
  assert.deepEqual(calls, [
    ["createPage", "session-1", "https://example.com"],
    ["drag", "session-1", "a", "b"],
    ["handleDialog", "session-1", { accept: false }],
    ["screenshot", "session-1", { scope: "element", ref: "b" }],
  ])
})

test("private runtime endpoints reject missing or wrong secrets", async (t) => {
  const baseUrl = await fixture(t)
  assert.equal((await fetch(`${baseUrl}/v1/health`)).status, 401)
  assert.equal(
    (await fetch(`${baseUrl}/v1/health`, { headers: { authorization: "Bearer wrong" } })).status,
    401
  )
})

test("health and control use a versioned authenticated protocol", async (t) => {
  const baseUrl = await fixture(t)
  const headers = {
    authorization: `Bearer ${"x".repeat(32)}`,
    "content-type": "application/json",
  }
  const health = await fetch(`${baseUrl}/v1/health`, { headers }).then((response) =>
    response.json()
  )
  assert.deepEqual(health, {
    version: 1,
    status: "ready",
    browser: "ready",
    supervisor: "ready",
  })

  const response = await fetch(`${baseUrl}/v1/control`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      version: 1,
      type: "browser.session.create",
      requestId: "req-1",
      payload: { id: "session-1" },
    }),
  }).then((result) => result.json())
  assert.deepEqual(response, {
    version: 1,
    type: "result",
    requestId: "req-1",
    payload: { id: "session-1", pages: [], activePageId: null },
  })
})

test("media endpoint returns only the latest frame and acknowledges by sequence", async (t) => {
  const baseUrl = await fixture(t)
  const headers = {
    authorization: `Bearer ${"x".repeat(32)}`,
    "content-type": "application/json",
  }
  await fetch(`${baseUrl}/v1/control`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      version: 1,
      type: "browser.screencast.start",
      payload: { sessionId: "session-1" },
    }),
  })
  const frame = await fetch(`${baseUrl}/v1/media/session-1?after=0`, { headers })
  assert.equal(frame.status, 200)
  assert.deepEqual(Buffer.from(await frame.arrayBuffer()), Buffer.from([1, 2, 3]))
})

test("audit events retain operation metadata without URLs, file paths, or human key input", async (t) => {
  const baseUrl = await fixture(t)
  const headers = {
    authorization: `Bearer ${"x".repeat(32)}`,
    "content-type": "application/json",
  }
  const control = (type, payload) =>
    fetch(`${baseUrl}/v1/control`, {
      method: "POST",
      headers,
      body: JSON.stringify({ version: 1, type, payload }),
    })
  await control("browser.navigate", {
    sessionId: "session-1",
    url: "https://app.example.com/private?token=do-not-log",
  })
  await control("browser.files.set", {
    sessionId: "session-1",
    ref: "opaque",
    paths: ["private/secret.txt"],
  })
  await control("browser.input", {
    sessionId: "session-1",
    input: { kind: "key", payload: { text: "human-secret" } },
  })

  const events = await fetch(`${baseUrl}/v1/events?after=0`, { headers }).then((response) =>
    response.json()
  )
  const serialized = JSON.stringify(events)
  assert.match(serialized, /app\.example\.com/)
  assert.match(serialized, /"fileCount":1/)
  assert.doesNotMatch(serialized, /do-not-log|private\/secret|human-secret/)
})
