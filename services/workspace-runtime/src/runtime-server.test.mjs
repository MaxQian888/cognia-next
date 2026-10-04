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
  assert.deepEqual(calls, [
    ["target", "s", "p2"],
    ["navigate", "s", "http://localhost/"],
    ["activatePage", "s", "p2"],
    ["navigate", "s", "http://localhost/x"],
    ["createPage", "s", undefined, { activate: false }],
  ])
})
