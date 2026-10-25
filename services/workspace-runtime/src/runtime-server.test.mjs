import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { RemoteChromiumService } from "./browser-service.mjs"
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

test("a media read with waitMs is answered by the next published frame", async (t) => {
  let publish = null
  const browser = serviceStub()
  browser.startScreencast = async (_sessionId, onFrame) => {
    publish = onFrame
  }
  const baseUrl = await fixture(t, browser)
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
  const started = Date.now()
  const pending = fetch(`${baseUrl}/v1/media/session-1?after=0&waitMs=1000`, { headers })
  setTimeout(() => void publish(Buffer.from([7, 8])), 50)
  const frame = await pending
  assert.equal(frame.status, 200)
  assert.equal(frame.headers.get("x-cognia-media-sequence"), "1")
  assert.deepEqual(Buffer.from(await frame.arrayBuffer()), Buffer.from([7, 8]))
  assert.ok(Date.now() - started < 900, "the frame wakes the read before its deadline")

  // Nothing newer than the cursor: the read waits out its (capped) deadline.
  const idleStart = Date.now()
  const idle = await fetch(`${baseUrl}/v1/media/session-1?after=1&waitMs=60`, { headers })
  assert.equal(idle.status, 204)
  assert.ok(Date.now() - idleStart >= 50)
  // A reader without waitMs keeps the immediate 204 older Rust shells expect.
  const immediate = await fetch(`${baseUrl}/v1/media/session-1?after=1`, { headers })
  assert.equal(immediate.status, 204)
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

test("dispatches every ADR-0201 browser operation to the service", async (t) => {
  const calls = []
  const browser = serviceStub()
  const record =
    (name, result = { ok: true }) =>
    async (...args) => {
      calls.push([name, ...args])
      return result
    }
  Object.assign(browser, {
    cancelDownload: record("cancelDownload"),
    deleteDownload: record("deleteDownload"),
    saveDownload: record("saveDownload"),
    reloadExtensions: record("reloadExtensions"),
    openExtensionPage: record("openExtensionPage"),
    setCookies: record("setCookies", { set: 1, skipped: 0 }),
    listCookies: record("listCookies"),
    clearCookies: record("clearCookies"),
    detectLoginForms: record("detectLoginForms"),
    fillCredential: record("fillCredential", { filled: true, username: "ada" }),
    pdf: record("pdf"),
    emulate: record("emulate"),
    storageGet: record("storageGet"),
    storageSet: record("storageSet"),
    storageClear: record("storageClear"),
    networkRequest: record("networkRequest"),
    finalizeTabs: record("finalizeTabs"),
    setFileChooserFiles: record("setFileChooserFiles", { ok: true, cancelled: false }),
  })
  const baseUrl = await fixture(t, browser)
  const headers = {
    authorization: `Bearer ${"x".repeat(32)}`,
    "content-type": "application/json",
  }
  const control = async (type, payload) => {
    const response = await fetch(`${baseUrl}/v1/control`, {
      method: "POST",
      headers,
      body: JSON.stringify({ version: 1, type, payload }),
    })
    assert.equal(response.status, 200, type)
    return (await response.json()).payload
  }
  const s = "session-1"
  await control("browser.download.cancel", { sessionId: s, downloadId: "d1" })
  await control("browser.download.delete", { sessionId: s, downloadId: "d1" })
  await control("browser.download.save", { sessionId: s, downloadId: "d1", targetPath: "/t" })
  await control("browser.extensions.reload", { extensionPaths: ["/e"] })
  await control("browser.extension.open", {
    sessionId: s,
    extensionId: "abc",
    page: "popup",
    path: "p.html",
  })
  await control("browser.cookies.set", { sessionId: s, cookies: [{ name: "a", value: "v" }] })
  await control("browser.cookies.list", { sessionId: s, domain: "example.com" })
  await control("browser.cookies.clear", { sessionId: s })
  await control("browser.forms.detect-login", { sessionId: s, pageId: "p1" })
  const filled = await control("browser.credential.fill", {
    sessionId: s,
    pageId: "p1",
    username: "ada",
    password: "pw",
  })
  assert.deepEqual(filled, { filled: true, username: "ada" })
  await control("browser.pdf", { sessionId: s, options: { landscape: true } })
  await control("browser.emulate", { sessionId: s, device: "Pixel 7", offline: true })
  await control("browser.storage.get", { sessionId: s, area: "local", key: "k" })
  await control("browser.storage.set", { sessionId: s, area: "local", key: "k", value: "v" })
  await control("browser.storage.clear", { sessionId: s, area: "session" })
  await control("browser.network.request", { sessionId: s, requestId: "r1" })
  await control("browser.tabs.finalize", { sessionId: s })
  await control("browser.filechooser.set", { sessionId: s, chooserId: "c1", paths: ["/u/a"] })
  assert.deepEqual(calls, [
    ["cancelDownload", s, "d1"],
    ["deleteDownload", s, "d1"],
    ["saveDownload", s, "d1", "/t"],
    ["reloadExtensions", ["/e"]],
    ["openExtensionPage", s, { extensionId: "abc", page: "popup", path: "p.html" }],
    ["setCookies", s, [{ name: "a", value: "v" }]],
    ["listCookies", s, { domain: "example.com" }],
    ["clearCookies", s, { domain: undefined }],
    ["detectLoginForms", s, { pageId: "p1" }],
    ["fillCredential", s, { pageId: "p1", username: "ada", password: "pw", origin: undefined }],
    ["pdf", s, { landscape: true }],
    ["emulate", s, { device: "Pixel 7", offline: true }],
    ["storageGet", s, { area: "local", key: "k", pageId: undefined }],
    ["storageSet", s, { area: "local", key: "k", value: "v", pageId: undefined }],
    ["storageClear", s, { area: "session", pageId: undefined }],
    ["networkRequest", s, "r1"],
    ["finalizeTabs", s],
    ["setFileChooserFiles", s, "c1", ["/u/a"]],
  ])
})

test("audit events never carry cookie values, credentials, storage values or local paths", async (t) => {
  const browser = serviceStub()
  Object.assign(browser, {
    setCookies: async () => ({ set: 1, skipped: 0 }),
    fillCredential: async () => ({ filled: true, username: "ada" }),
    storageSet: async () => ({ origin: "https://x", key: "k" }),
    createSession: async ({ id }) => ({ id, pages: [], activePageId: null }),
  })
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
  await control("browser.session.create", {
    id: "s1",
    kind: "user-chrome",
    headless: true,
    cdpEndpoint: "ws://127.0.0.1:9222/devtools/browser/SECRET-ENDPOINT",
    downloadsDir: "/Users/me/PRIVATE-DOWNLOADS",
    uploadRoots: ["/Users/me/PRIVATE-UPLOADS"],
    extensionPaths: ["/Users/me/PRIVATE-EXT"],
    allowFileUrls: false,
  })
  await control("browser.cookies.set", {
    sessionId: "s1",
    cookies: [{ name: "sid", value: "COOKIE-VALUE", domain: "COOKIE-DOMAIN.test" }],
  })
  await control("browser.credential.fill", {
    sessionId: "s1",
    username: "USER-NAME",
    password: "PASS-WORD",
  })
  await control("browser.storage.set", {
    sessionId: "s1",
    area: "local",
    key: "STORAGE-KEY",
    value: "STORAGE-VALUE",
  })
  const events = await fetch(`${baseUrl}/v1/events?after=0`, { headers }).then((response) =>
    response.json()
  )
  const serialized = JSON.stringify(events)
  assert.doesNotMatch(
    serialized,
    /SECRET-ENDPOINT|PRIVATE-|COOKIE-VALUE|COOKIE-DOMAIN|USER-NAME|PASS-WORD|STORAGE-KEY|STORAGE-VALUE/
  )
  const create = events.payload.find((event) => event.operation === "browser.session.create")
  assert.equal(create.kind, "user-chrome")
  assert.equal(create.extensionCount, 1)
  assert.equal(
    events.payload.find((event) => event.operation === "browser.cookies.set").cookieCount,
    1
  )
  assert.equal(
    events.payload.find((event) => event.operation === "browser.storage.set").area,
    "local"
  )
})

test("sensitive journal events are scrubbed once acknowledged or expired", async () => {
  const { RuntimeEventJournal } = await import("./runtime-server.mjs")
  let now = 0
  const journal = new RuntimeEventJournal(512, { sensitiveTtlMs: 1000, now: () => now })
  journal.publish({
    kind: "browser.event",
    type: "credential.submitted",
    sessionId: "s1",
    origin: "https://x",
    username: "ada",
    password: "pw-1",
    sensitive: true,
  })
  journal.publish({ kind: "browser.event", type: "pages.changed", sessionId: "s1" })
  const [first] = journal.after(0)
  assert.equal(first.password, "pw-1")
  assert.equal("sensitive" in first, false)
  // Polling again from 0 (no acknowledgement) still delivers it inside the TTL.
  assert.equal(journal.after(0)[0].password, "pw-1")
  // Acknowledged: the reader moved past it.
  journal.after(1)
  assert.equal(journal.after(0)[0].password, undefined)
  assert.equal(journal.after(0)[0].scrubbed, true)
  assert.equal(journal.after(0)[0].username, "ada")

  journal.publish({ type: "credential.submitted", password: "pw-2", sensitive: true })
  now = 1000
  const expired = journal.after(0).find((event) => event.sequence === 3)
  assert.equal(expired.password, undefined)

  const small = new RuntimeEventJournal(1)
  small.publish({ type: "credential.submitted", password: "pw-3", sensitive: true })
  const evicted = small.events[0]
  small.publish({ type: "pages.changed" })
  assert.equal(evicted.password, undefined)
  assert.equal(small.sensitive.size, 0)
})

test("runs without a supervisor and refuses agent operations", async (t) => {
  const browserService = { ...serviceStub(), mode: "local" }
  const runtime = createRuntimeServer({ secret: "x".repeat(32), browserService })
  const address = await runtime.listen(0, "127.0.0.1")
  t.after(() => runtime.close())
  const headers = {
    authorization: `Bearer ${"x".repeat(32)}`,
    "content-type": "application/json",
  }
  const health = await fetch(`http://127.0.0.1:${address.port}/v1/health`, { headers }).then(
    (response) => response.json()
  )
  assert.equal(health.supervisor, "absent")
  assert.equal(health.mode, "local")
  for (const type of ["agent.spawn", "agent.list", "toString", "__proto__"]) {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/control`, {
      method: "POST",
      headers,
      body: JSON.stringify({ version: 1, type, payload: {} }),
    })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).code, "unknown_operation")
  }
})

function loginFrame(url, filled) {
  const element = {
    asElement() {
      return this
    },
    async fill(value) {
      filled.push([url, value])
    },
    async dispose() {},
  }
  return {
    url: () => url,
    evaluate: async (fn) =>
      fn.name === "detectLoginFormsInPage" ? [{ key: "lf1", hasUsername: true }] : null,
    evaluateHandle: async () => element,
  }
}

test("browser.credential.fill forwards origin, pageId, username and password; the service fills only a matching origin", async (t) => {
  // Pin the payload keys Rust sends.
  const forwarded = []
  const stub = serviceStub()
  stub.fillCredential = async (...args) => {
    forwarded.push(args)
    return { filled: true, username: "ada" }
  }
  const stubUrl = await fixture(t, stub)
  const headers = {
    authorization: `Bearer ${"x".repeat(32)}`,
    "content-type": "application/json",
  }
  const payload = {
    sessionId: "s1",
    pageId: "p1",
    origin: "https://login.example.com",
    username: "ada",
    password: "pw",
  }
  const stubbed = await fetch(`${stubUrl}/v1/control`, {
    method: "POST",
    headers,
    body: JSON.stringify({ version: 1, type: "browser.credential.fill", payload }),
  })
  assert.equal(stubbed.status, 200)
  assert.deepEqual(forwarded, [
    ["s1", { pageId: "p1", username: "ada", password: "pw", origin: "https://login.example.com" }],
  ])

  // The real service behind the control plane: a mismatched origin fills nothing.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cognia-runtime-fill-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const service = new RemoteChromiumService({
    chromium: {},
    overlayScript: "",
    profilesRoot: path.join(root, "profiles"),
    mode: "local",
  })
  t.after(() => clearInterval(service.reaper))
  const filled = []
  const mainFrame = loginFrame("https://login.example.com/signin", filled)
  const iframe = loginFrame("https://evil.example.net/frame", filled)
  const page = { mainFrame: () => mainFrame, frames: () => [mainFrame, iframe], url: () => "" }
  const session = service.newSessionRecord({ id: "s1", kind: "local" })
  session.id = "s1"
  session.pages.set("p1", { page })
  service.sessions.set("s1", session)
  const runtime = createRuntimeServer({ secret: "x".repeat(32), browserService: service })
  const address = await runtime.listen(0, "127.0.0.1")
  t.after(() => runtime.close())
  const fill = async (overrides) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/control`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        version: 1,
        type: "browser.credential.fill",
        payload: { ...payload, ...overrides },
      }),
    })
    return { status: response.status, body: await response.json() }
  }

  const mismatch = await fill({ origin: "https://other.example.org" })
  assert.equal(mismatch.status, 200)
  assert.deepEqual(mismatch.body.payload, {
    filled: false,
    username: null,
    reason: "origin_mismatch",
  })
  assert.deepEqual(filled, [])

  const invalid = await fill({ origin: "not a url" })
  assert.equal(invalid.body.code, "browser_credential_invalid")
  assert.deepEqual(filled, [])

  // A matching origin fills the same-origin main-frame form; the
  // cross-origin iframe never receives the credential.
  const matched = await fill({ origin: "https://login.example.com" })
  assert.deepEqual(matched.body.payload, { filled: true, username: "ada" })
  assert.deepEqual(filled, [
    ["https://login.example.com/signin", "ada"],
    ["https://login.example.com/signin", "pw"],
  ])
  assert.doesNotMatch(JSON.stringify(matched.body), /"pw"/)
})

test("a named pageId addresses that tab, except where the page is the op's subject", async (t) => {
  const calls = []
  const browser = serviceStub()
  browser.withPageTarget = async (sessionId, pageId, operation) => {
    calls.push(["target", sessionId, pageId])
    return operation()
  }
  browser.navigate = async (...args) => {
    calls.push(["navigate", ...args])
    return { ok: true, error: null, generation: 1 }
  }
  browser.activatePage = async (...args) => {
    calls.push(["activatePage", ...args])
  }
  browser.createPage = async (...args) => {
    calls.push(["createPage", ...args])
    return { id: "page-3", url: "about:blank", title: "", active: false }
  }
  browser.recordingControl = async (...args) => {
    calls.push(["recordingControl", ...args])
    return null
  }
  browser.resolveRecordedTarget = async (...args) => {
    calls.push(["resolveRecordedTarget", ...args])
    return "opaque-ref"
  }
  const baseUrl = await fixture(t, browser)
  const control = (type, payload) =>
    fetch(`${baseUrl}/v1/control`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${"x".repeat(32)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ version: 1, type, payload }),
    })
  await control("browser.navigate", { sessionId: "s", pageId: "p2", url: "http://localhost/" })
  await control("browser.page.activate", { sessionId: "s", pageId: "p2" })
  await control("browser.navigate", { sessionId: "s", url: "http://localhost/x" })
  await control("browser.page.create", { sessionId: "s", activate: false })
  await control("browser.recording.control", { sessionId: "s", pageId: "p2", action: "drain" })
  await control("browser.recording.ref", { sessionId: "s", pageId: "p2", selector: "#submit" })
  assert.deepEqual(calls, [
    ["target", "s", "p2"],
    ["navigate", "s", "http://localhost/"],
    ["activatePage", "s", "p2"],
    ["navigate", "s", "http://localhost/x"],
    ["createPage", "s", undefined, { activate: false }],
    ["target", "s", "p2"],
    ["recordingControl", "s", "drain"],
    ["target", "s", "p2"],
    ["resolveRecordedTarget", "s", "#submit"],
  ])
})

test("pick and adjust ops reach the service on the tab they name", async (t) => {
  const calls = []
  const browser = serviceStub()
  browser.withPageTarget = async (sessionId, pageId, operation) => {
    calls.push(["target", sessionId, pageId])
    return operation()
  }
  for (const method of [
    "setSelectMode",
    "drainSelection",
    "clearSelection",
    "selectionForRef",
    "adjust",
  ]) {
    browser[method] = async (...args) => {
      calls.push([method, ...args])
      return { ok: true }
    }
  }
  const baseUrl = await fixture(t, browser)
  const control = (type, payload) =>
    fetch(`${baseUrl}/v1/control`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${"x".repeat(32)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ version: 1, type, payload }),
    })
  const labels = { details: "Details", collapse: "Hide" }
  await control("browser.select-mode", { sessionId: "s", pageId: "p2", on: true, labels })
  await control("browser.selection.drain", { sessionId: "s", pageId: "p2" })
  await control("browser.selection.clear", { sessionId: "s", pageId: "p2" })
  await control("browser.selection.for-ref", { sessionId: "s", pageId: "p2", ref: "r1" })
  await control("browser.adjust", {
    sessionId: "s",
    pageId: "p2",
    action: "revert",
    input: { previewId: "x" },
  })
  assert.deepEqual(calls, [
    ["target", "s", "p2"],
    ["setSelectMode", "s", true, labels],
    ["target", "s", "p2"],
    ["drainSelection", "s"],
    ["target", "s", "p2"],
    ["clearSelection", "s"],
    ["target", "s", "p2"],
    ["selectionForRef", "s", "r1"],
    ["target", "s", "p2"],
    ["adjust", "s", "revert", { previewId: "x" }],
  ])
})

test("media generations release retained bytes and reject late publishers without tombstones", async () => {
  const { MediaLatestStore } = await import("./runtime-server.mjs")
  const media = new MediaLatestStore()
  const first = media.publisher("reused")
  first(Buffer.alloc(1024 * 1024))
  const cursor = media.latest("reused", 0).sequence
  const pending = media.next("reused", cursor, 1000)
  media.release("reused")
  const replacement = media.publisher("reused")
  replacement(Buffer.from("new"))
  first(Buffer.from("stale"))
  media.release("reused", first)
  assert.equal(await pending, null, "old polls cannot consume a replacement session's frame")
  const frame = media.latest("reused", cursor)
  assert.equal(frame.bytes.toString(), "new")
  assert.ok(frame.sequence > cursor, "cursor remains monotonic after a session id is reused")
  media.release("reused")
  for (let i = 0; i < 100; i += 1) {
    media.publisher(`closed-${i}`)(Buffer.alloc(1024))
    media.release(`closed-${i}`)
  }
  assert.equal(media.sessions.size, 0, "closed sessions leave neither bytes nor tombstones")
})

test("media waiter timeout and abort remove empty session state", async () => {
  const { MediaLatestStore } = await import("./runtime-server.mjs")
  const media = new MediaLatestStore()
  assert.equal(await media.next("timeout", 0, 5), null)
  assert.equal(media.sessions.size, 0)
  const abort = new AbortController()
  const pending = media.next("abort", 0, 1000, abort.signal)
  abort.abort()
  assert.equal(await pending, null)
  assert.equal(media.sessions.size, 0)
  const publish = media.publisher("shutdown")
  publish(Buffer.alloc(1024))
  const waiting = media.next("shutdown", media.latest("shutdown", 0).sequence, 1000)
  media.clear()
  publish(Buffer.from("late"))
  assert.equal(await waiting, null)
  assert.equal(media.sessions.size, 0)
})

test("runtime releases media on lifecycle events and explicit close with legacy services", async (t) => {
  const browser = serviceStub()
  let publish
  let listener
  let unsubscribed = false
  browser.subscribeEvents = (sink) => {
    listener = sink
    return () => {
      unsubscribed = true
    }
  }
  browser.startScreencast = async (_id, sink) => {
    publish = sink
  }
  const runtime = createRuntimeServer({ secret: "x".repeat(32), browserService: browser })
  const address = await runtime.listen(0, "127.0.0.1")
  const baseUrl = `http://127.0.0.1:${address.port}`
  const headers = { authorization: `Bearer ${"x".repeat(32)}`, "content-type": "application/json" }
  t.after(() => runtime.close())
  const control = (type) =>
    fetch(`${baseUrl}/v1/control`, {
      method: "POST",
      headers,
      body: JSON.stringify({ version: 1, type, payload: { sessionId: "s" } }),
    })
  await control("browser.screencast.start")
  publish(Buffer.from("old"))
  assert.equal((await fetch(`${baseUrl}/v1/media/s`, { headers })).status, 200)
  assert.equal(typeof listener, "function")
  listener({ type: "session.closed", sessionId: "s", reason: "disconnected" })
  publish(Buffer.from("late"))
  assert.equal((await fetch(`${baseUrl}/v1/media/s`, { headers })).status, 204)
  await control("browser.screencast.start")
  publish(Buffer.from("next"))
  await control("browser.session.close")
  publish(Buffer.from("late close"))
  assert.equal((await fetch(`${baseUrl}/v1/media/s`, { headers })).status, 204)
  await runtime.close()
  assert.equal(unsubscribed, true)
})

test("explicit close releases media for services without subscriptions", async (t) => {
  const browser = serviceStub()
  let publish
  browser.startScreencast = async (_id, sink) => {
    publish = sink
  }
  const baseUrl = await fixture(t, browser)
  const headers = { authorization: `Bearer ${"x".repeat(32)}`, "content-type": "application/json" }
  for (const type of ["browser.screencast.start", "browser.session.close"]) {
    await fetch(`${baseUrl}/v1/control`, {
      method: "POST",
      headers,
      body: JSON.stringify({ version: 1, type, payload: { sessionId: "legacy" } }),
    })
    publish(Buffer.from(type))
  }
  assert.equal((await fetch(`${baseUrl}/v1/media/legacy`, { headers })).status, 204)
})

test("a failed capture start invalidates its publisher without releasing a replacement generation", async (t) => {
  const browser = serviceStub()
  let fail
  let oldPublisher
  let newPublisher
  let starts = 0
  browser.startScreencast = (_id, publish) => {
    if (starts++ === 0) {
      oldPublisher = publish
      return new Promise((_resolve, reject) => {
        fail = reject
      })
    }
    newPublisher = publish
    publish(Buffer.from("replacement"))
    return Promise.resolve()
  }
  const baseUrl = await fixture(t, browser)
  const headers = { authorization: `Bearer ${"x".repeat(32)}`, "content-type": "application/json" }
  const control = (type) =>
    fetch(`${baseUrl}/v1/control`, {
      method: "POST",
      headers,
      body: JSON.stringify({ version: 1, type, payload: { sessionId: "reused" } }),
    })
  const starting = control("browser.screencast.start")
  while (!fail) await new Promise((resolve) => setImmediate(resolve))
  oldPublisher(Buffer.from("old"))
  await control("browser.session.close")
  await control("browser.screencast.start")
  fail(new Error("old capture failed"))
  assert.equal((await starting).status, 400)
  oldPublisher(Buffer.from("late"))
  const response = await fetch(`${baseUrl}/v1/media/reused`, { headers })
  assert.equal(await response.text(), "replacement")
  await control("browser.session.close")
  newPublisher(Buffer.from("late replacement"))
  assert.equal((await fetch(`${baseUrl}/v1/media/reused`, { headers })).status, 204)
})

test("submission ops reach the service; a drain addresses its tab and is not audited", async (t) => {
  const calls = []
  const browser = serviceStub()
  browser.withPageTarget = async (sessionId, pageId, operation) => {
    calls.push(["target", sessionId, pageId])
    return operation()
  }
  browser.configureSubmissionGuard = async (...args) => {
    calls.push(["configure", ...args])
    return { mode: args[1] }
  }
  browser.drainSubmissions = async (...args) => {
    calls.push(["drain", ...args])
    return { pageId: "p2", reports: [], windowOpen: false }
  }
  browser.resolveSubmission = (...args) => {
    calls.push(["resolve", ...args])
    return { id: args[1], decision: args[2] }
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
    }).then((response) => response.json())
  await control("browser.submission.configure", { sessionId: "s", mode: "hold" })
  const drained = await control("browser.submission.drain", {
    sessionId: "s",
    pageId: "p2",
    waitMs: 200,
  })
  await control("browser.submission.resolve", { sessionId: "s", holdId: "h1", decision: "refuse" })
  assert.deepEqual(calls, [
    ["configure", "s", "hold"],
    ["target", "s", "p2"],
    ["drain", "s", { waitMs: 200 }],
    ["resolve", "s", "h1", "refuse"],
  ])
  assert.deepEqual(drained.payload, { pageId: "p2", reports: [], windowOpen: false })

  const events = await fetch(`${baseUrl}/v1/events?after=0`, { headers }).then((response) =>
    response.json()
  )
  const operations = events.payload
    .filter((event) => event.kind === "runtime.operation")
    .map(({ operation, submissionMode, submissionDecision }) => ({
      operation,
      ...(submissionMode ? { submissionMode } : {}),
      ...(submissionDecision ? { submissionDecision } : {}),
    }))
  assert.deepEqual(operations, [
    { operation: "browser.submission.configure", submissionMode: "hold" },
    { operation: "browser.submission.resolve", submissionDecision: "refuse" },
  ])
})
