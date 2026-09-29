import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  COOKIES_IMPORTED_MARKER,
  LOCAL_SESSION_FIELDS,
  RemoteChromiumService,
  assertLoopbackCdpEndpoint,
  isLoopbackOrigin,
} from "./browser-service.mjs"
import { WorkspaceFileBridge } from "./file-bridge.mjs"
import { CREDENTIAL_BINDING, CREDENTIAL_CAPTURE_SCRIPT } from "./page-scripts.mjs"

let targetSeq = 0

class FakeElement {
  constructor() {
    this.filled = []
    this.disposed = false
  }
  asElement() {
    return this
  }
  async fill(value) {
    this.filled.push(value)
  }
  async setInputFiles(paths) {
    this.files = paths
  }
  async evaluate() {
    return false
  }
  async dispose() {
    this.disposed = true
  }
}

class FakeFrame {
  constructor(page, url) {
    this.page = page
    this._url = url
    this.loginForms = []
    this.loginElements = new Map()
    this.storage = { local: new Map(), session: new Map() }
    this.storageThrows = false
  }
  url() {
    return this._url
  }
  async evaluate(fn, argument) {
    const name = fn.name
    if (name === "detectLoginFormsInPage") return this.loginForms
    if (
      name === "readStorageInPage" ||
      name === "writeStorageInPage" ||
      name === "clearStorageInPage"
    ) {
      if (this.storageThrows) throw new Error("SecurityError: access denied")
      const store = this.storage[argument.area]
      const origin = new URL(this._url).origin
      if (name === "writeStorageInPage") {
        store.set(argument.key, argument.value)
        return { origin, key: argument.key }
      }
      if (name === "clearStorageInPage") {
        const cleared = store.size
        store.clear()
        return { origin, cleared }
      }
      if (typeof argument.key === "string") {
        return { origin, key: argument.key, value: store.get(argument.key) ?? null }
      }
      return { origin, entries: Object.fromEntries(store) }
    }
    return null
  }
  async evaluateHandle(fn, argument) {
    if (fn.name === "resolveLoginRegistryEntry") {
      const element = this.loginElements.get(argument.key)
      return element ?? { asElement: () => null, dispose: async () => undefined }
    }
    return new FakeElement()
  }
}

class FakePage extends EventEmitter {
  constructor(context, url = "about:blank") {
    super()
    this._context = context
    this._url = url
    this._title = ""
    this.targetId = `target-${++targetSeq}`
    this.mainFrame = new FakeFrame(this, url)
    this.childFrames = []
    this.initScripts = []
    this.closed = false
    this.viewport = { width: 1280, height: 720 }
    this.media = []
    this._opener = null
  }
  url() {
    return this._url
  }
  title() {
    return Promise.resolve(this._title)
  }
  frames() {
    return [this.mainFrame, ...this.childFrames]
  }
  async goto(url) {
    this._url = url
    this.mainFrame._url = url
    this.emit("framenavigated", this.mainFrame)
  }
  async addInitScript(script) {
    this.initScripts.push(script)
  }
  async bringToFront() {}
  async close() {
    if (this.closed) return
    this.closed = true
    this._context._pages = this._context._pages.filter((page) => page !== this)
    this.emit("close")
  }
  async opener() {
    return this._opener
  }
  viewportSize() {
    return this.viewport
  }
  async setViewportSize(viewport) {
    this.viewport = viewport
  }
  async emulateMedia(options) {
    this.media.push(options)
  }
  async evaluate() {
    return null
  }
}

class FakeCdp extends EventEmitter {
  constructor(handler = () => undefined) {
    super()
    this.commands = []
    this.handler = handler
    this.detached = false
  }
  async send(method, params) {
    this.commands.push([method, params])
    return this.handler(method, params)
  }
  async detach() {
    this.detached = true
  }
}

class FakeContext extends EventEmitter {
  constructor(browser, { initialPages = 1 } = {}) {
    super()
    this._browser = browser
    this._pages = []
    this.initScripts = []
    this.bindings = new Map()
    this.cookieJar = []
    this.cdpSessions = []
    this.permissions = []
    this.closed = false
    for (let index = 0; index < initialPages; index += 1) this._pages.push(new FakePage(this))
  }
  browser() {
    return this._browser
  }
  pages() {
    return [...this._pages]
  }
  async newPage() {
    const page = new FakePage(this)
    this._pages.push(page)
    this.emit("page", page)
    return page
  }
  async addInitScript(script) {
    this.initScripts.push(script)
  }
  async exposeBinding(name, callback) {
    this.bindings.set(name, callback)
  }
  async route(_pattern, handler) {
    this.routeHandler = handler
  }
  async cookies() {
    return this.cookieJar.map((cookie) => ({ ...cookie }))
  }
  async addCookies(cookies) {
    for (const cookie of cookies) {
      if (cookie.name === "reject-me") throw new Error("Invalid cookie fields")
    }
    this.cookieJar.push(...cookies)
  }
  async clearCookies(filter) {
    this.clearFilter = filter
    this.cookieJar = filter?.domain
      ? this.cookieJar.filter((cookie) => !filter.domain.test(cookie.domain.replace(/^\./, "")))
      : []
  }
  async grantPermissions(permissions, options) {
    this.permissions.push([permissions, options])
  }
  async newCDPSession(page) {
    const cdp = new FakeCdp((method) => {
      if (method === "Target.getTargetInfo") return { targetInfo: { targetId: page.targetId } }
      if (method === "Page.printToPDF") return { data: Buffer.from("%PDF-1.7").toString("base64") }
      return undefined
    })
    this.cdpSessions.push({ page, cdp })
    return cdp
  }
  async close() {
    this.closed = true
    for (const page of [...this._pages]) await page.close()
    this.emit("close")
  }
}

class FakeBrowser extends EventEmitter {
  constructor() {
    super()
    this.cdpSessions = []
    this.closed = false
    this.context = null
  }
  contexts() {
    return this.context ? [this.context] : []
  }
  async newBrowserCDPSession() {
    const cdp = new FakeCdp(async (method, params) => {
      if (method === "Target.createTarget") {
        const page = new FakePage(this.context)
        this.context._pages.push(page)
        this.context.emit("page", page)
        return { targetId: page.targetId, params }
      }
      return undefined
    })
    this.cdpSessions.push(cdp)
    return cdp
  }
  async close() {
    this.closed = true
    this.emit("disconnected")
  }
}

function fakeChromium() {
  const launches = []
  const connections = []
  return {
    launches,
    connections,
    async launchPersistentContext(profilePath, options) {
      const browser = new FakeBrowser()
      const context = new FakeContext(browser)
      browser.context = context
      launches.push({ profilePath, options, context, browser })
      return context
    },
    async connectOverCDP(endpoint, options) {
      if (endpoint.includes("9999")) throw new Error("connect ECONNREFUSED")
      const browser = new FakeBrowser()
      // The user's Chrome already has their own tabs open.
      const context = new FakeContext(browser, { initialPages: 2 })
      context._pages[0]._url = "https://mail.example.com/"
      browser.context = context
      connections.push({ endpoint, options, context, browser })
      return browser
    },
    async launch() {
      throw new Error("cloud launch is not used by local tests")
    },
  }
}

const devices = {
  "Pixel 7": {
    viewport: { width: 412, height: 839 },
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7)",
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
  },
}

async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cognia-browser-local-")))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const chromium = fakeChromium()
  const events = []
  let id = 0
  const downloadsDir = path.join(root, "Downloads")
  const service = new RemoteChromiumService({
    chromium,
    devices,
    overlayScript: "window.__overlay = true",
    profilesRoot: path.join(root, "profiles"),
    mode: "local",
    onEvent: (event) => events.push(event),
    eventDebounceMs: 0,
    createId: () => `id-${++id}`,
    ...options,
  })
  t.after(() => service.closeAll())
  return { service, chromium, events, root, downloadsDir }
}

function tick(ms = 5) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function cloudFixture(t) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cognia-browser-cloud-"))
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }))
  const context = new FakeContext(null)
  const chromium = {
    async launch() {
      return { newContext: async () => context, close: async () => {}, on() {} }
    },
  }
  const events = []
  const service = new RemoteChromiumService({
    chromium,
    overlayScript: "",
    workspaceRoot,
    profilesRoot: path.join(workspaceRoot, ".profiles"),
    fileBridge: new WorkspaceFileBridge({ workspaceRoot }),
    networkPolicyFactory: () => ({
      resolverRules: async () => "",
      authorize: async (url) => ({ url }),
      authorizeRedirect: async (_from, url) => ({ url }),
    }),
    onEvent: (event) => events.push(event),
    eventDebounceMs: 0,
  })
  t.after(() => service.closeAll())
  return { service, context, events, workspaceRoot }
}

test("cloud mode refuses every local-only session option with a typed error", async (t) => {
  const { service } = await cloudFixture(t)
  const samples = {
    kind: "local",
    headless: false,
    extensionPaths: ["/ext"],
    cdpEndpoint: "ws://127.0.0.1:9222/devtools/browser/x",
    downloadsDir: "/tmp",
    uploadRoots: ["/tmp"],
    allowFileUrls: true,
    viewport: { width: 800, height: 600 },
  }
  assert.deepEqual(Object.keys(samples).sort(), [...LOCAL_SESSION_FIELDS].sort())
  for (const [field, value] of Object.entries(samples)) {
    await assert.rejects(
      () => service.createSession({ id: `s-${field}`, grants: [], [field]: value }),
      (error) => error.code === "browser_local_option_unsupported" && error.message.includes(field)
    )
  }
  await assert.doesNotReject(() => service.createSession({ id: "plain", grants: [] }))
})

test("cloud mode refuses privileged and local-only operations", async (t) => {
  const { service } = await cloudFixture(t)
  await service.createSession({ id: "s1", grants: [] })
  await assert.rejects(
    () => service.setCookies("s1", []),
    (error) => error.code === "browser_local_only"
  )
  await assert.rejects(
    () => service.fillCredential("s1", { username: "a", password: "b" }),
    (error) => error.code === "browser_local_only"
  )
  await assert.rejects(
    () => service.reloadExtensions([]),
    (error) => error.code === "browser_local_only"
  )
  await assert.rejects(
    () => service.openExtensionPage("s1", {}),
    (error) => error.code === "browser_local_only"
  )
  await assert.rejects(
    () => service.finalizeTabs("s1"),
    (error) => error.code === "browser_feature_unsupported"
  )
})

test("cloud pdf is quarantined and published as a remote download", async (t) => {
  const { service, events } = await cloudFixture(t)
  await service.createSession({ id: "s1", grants: [] })
  const result = await service.pdf("s1", { filename: "invoice" })
  assert.equal(result.download.state, "quarantined")
  assert.equal(result.download.filename, "invoice.pdf")
  assert.equal(result.download.backend, "remote")
  assert.equal(result.path, undefined)
  assert.equal(events.at(-1).type, "download.updated")
  const [listed] = service.listDownloads("s1")
  assert.equal(listed.backend, "remote")
  await assert.rejects(
    () => service.cancelDownload("s1", listed.id),
    (error) => error.code === "browser_download_not_cancellable"
  )
  await assert.rejects(
    () => service.deleteDownload("s1", "someone-elses"),
    (error) => error.code === "browser_download_not_found"
  )
  assert.deepEqual(await service.deleteDownload("s1", listed.id), { deleted: true, id: listed.id })
})

test("launches local Chromium on the persistent profile with extensions and staged downloads", async (t) => {
  const { service, chromium, downloadsDir, root } = await fixture(t)
  const summary = await service.createSession({
    id: "s1",
    headless: false,
    extensionPaths: ["/ext/one", "/ext/two"],
    downloadsDir,
    viewport: { width: 1024, height: 768 },
  })
  assert.equal(summary.kind, "local")
  assert.equal(summary.profileId, "default")
  assert.equal(summary.pages.length, 1)
  const [launch] = chromium.launches
  assert.equal(launch.profilePath, path.join(root, "profiles", "default"))
  assert.deepEqual(launch.options, {
    channel: "chromium",
    headless: false,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions-except=/ext/one,/ext/two",
      "--load-extension=/ext/one,/ext/two",
    ],
    ignoreDefaultArgs: ["--disable-extensions"],
    acceptDownloads: true,
    downloadsPath: path.join(root, ".download-staging"),
    viewport: { width: 1024, height: 768 },
  })
  assert.deepEqual(launch.context.initScripts, [
    "window.__overlay = true",
    CREDENTIAL_CAPTURE_SCRIPT,
  ])
  assert.ok(launch.context.bindings.has(CREDENTIAL_BINDING))
  assert.deepEqual(launch.browser.cdpSessions[0].commands[0], [
    "Browser.setDownloadBehavior",
    {
      behavior: "allowAndName",
      downloadPath: path.join(root, ".download-staging"),
      eventsEnabled: true,
    },
  ])
  await fs.stat(downloadsDir)
})

test("validates local session options", async (t) => {
  const { service } = await fixture(t)
  const cases = [
    [{ kind: "remote" }, "browser_session_option_invalid"],
    [{ headless: "yes" }, "browser_session_option_invalid"],
    [{ extensionPaths: ["relative/ext"] }, "browser_session_option_invalid"],
    [{ extensionPaths: ["/a,b"] }, "browser_session_option_invalid"],
    [{ downloadsDir: "Downloads" }, "browser_session_option_invalid"],
    [{ uploadRoots: "/tmp" }, "browser_session_option_invalid"],
    [{ allowFileUrls: 1 }, "browser_session_option_invalid"],
    [{ viewport: { width: 10, height: 10 } }, "browser_session_option_invalid"],
    [{ cdpEndpoint: "ws://127.0.0.1:9222/x" }, "browser_session_option_invalid"],
    [{ kind: "user-chrome" }, "browser_cdp_endpoint_invalid"],
    [{ kind: "user-chrome", cdpEndpoint: "ws://10.0.0.5:9222/x" }, "browser_cdp_endpoint_invalid"],
    [
      { kind: "user-chrome", cdpEndpoint: "ws://127.0.0.1:9222/x", extensionPaths: ["/e"] },
      "extensions_unsupported_backend",
    ],
    [{ profileId: "../escape" }, "browser_profile_invalid"],
  ]
  for (const [options, code] of cases) {
    await assert.rejects(
      () => service.createSession({ id: "bad", ...options }),
      (error) => error.code === code,
      JSON.stringify(options)
    )
  }
  assert.equal(service.sessions.size, 0)
})

test("assertLoopbackCdpEndpoint accepts only loopback DevTools addresses", () => {
  assert.equal(
    assertLoopbackCdpEndpoint("ws://127.0.0.1:9222/devtools/browser/abc"),
    "ws://127.0.0.1:9222/devtools/browser/abc"
  )
  assert.doesNotThrow(() => assertLoopbackCdpEndpoint("http://localhost:9222"))
  assert.doesNotThrow(() => assertLoopbackCdpEndpoint("ws://[::1]:9222/devtools/browser/x"))
  for (const bad of [
    "wss://127.0.0.1:9222/x",
    "ws://example.com:9222/x",
    "ws://127.0.0.1/x",
    "file:///tmp/sock",
    "nope",
  ]) {
    assert.throws(() => assertLoopbackCdpEndpoint(bad), { code: "browser_cdp_endpoint_invalid" })
  }
})

test("publishes pages.changed, dialog.opened and session.closed events", async (t) => {
  const { service, chromium, events } = await fixture(t)
  await service.createSession({ id: "s1" })
  await tick()
  const context = chromium.launches[0].context
  const page = context._pages[0]
  await page.goto("https://example.com/")
  page._title = "Example"
  await tick()
  const pagesChanged = events.filter((event) => event.type === "pages.changed")
  assert.ok(pagesChanged.length >= 1)
  assert.equal(pagesChanged.at(-1).kind, "browser.event")
  assert.equal(pagesChanged.at(-1).sessionId, "s1")
  assert.equal(pagesChanged.at(-1).pages[0].url, "https://example.com/")

  page.emit("dialog", {
    type: () => "alert",
    message: () => "Hi",
    defaultValue: () => "",
    dismiss: async () => undefined,
  })
  assert.deepEqual(
    events.find((event) => event.type === "dialog.opened"),
    {
      kind: "browser.event",
      type: "dialog.opened",
      sessionId: "s1",
      pageId: pageIdOf(service, "s1", page),
      dialog: { type: "alert", message: "Hi", defaultValue: "" },
    }
  )
  await service.closeSession("s1")
  assert.deepEqual(events.at(-1), {
    kind: "browser.event",
    type: "session.closed",
    sessionId: "s1",
    reason: "closed",
  })
  assert.equal(context.closed, true)
})

function pageIdOf(service, sessionId, page) {
  return service.sessions.get(sessionId).pageIds.get(page)
}

test("a crashed local browser publishes session.closed with reason disconnected", async (t) => {
  const { service, chromium, events } = await fixture(t)
  await service.createSession({ id: "s1" })
  chromium.launches[0].context.emit("close")
  await tick()
  assert.equal(events.at(-1).type, "session.closed")
  assert.equal(events.at(-1).reason, "disconnected")
  assert.equal(service.sessions.size, 0)
  assert.equal(service.profileOwners.size, 0)
})

test("local downloads are saved with collision-safe names and published with progress", async (t) => {
  const { service, chromium, events, downloadsDir } = await fixture(t)
  await service.createSession({ id: "s1", downloadsDir })
  await fs.writeFile(path.join(downloadsDir, "data.csv"), "old")
  const { context, browser } = chromium.launches[0]
  const page = context._pages[0]
  let complete
  const download = {
    url: () => "https://files.example/data.csv",
    suggestedFilename: () => "data.csv",
    path: () => new Promise((resolve) => (complete = () => resolve("/staging/guid"))),
    failure: async () => null,
    saveAs: async (target) => fs.writeFile(target, "a,b\n1,2\n"),
    cancel: async () => undefined,
  }
  page.emit("download", download)
  const progress = browser.cdpSessions[0]
  progress.emit("Browser.downloadWillBegin", {
    guid: "g1",
    url: "https://files.example/data.csv",
    suggestedFilename: "data.csv",
    frameId: page.targetId,
  })
  progress.emit("Browser.downloadProgress", {
    guid: "g1",
    totalBytes: 8,
    receivedBytes: 3,
    state: "inProgress",
  })
  complete()
  await tick()
  const [summary] = service.listDownloads("s1")
  assert.equal(summary.state, "completed")
  assert.equal(summary.filename, "data (1).csv")
  assert.equal(summary.backend, "local-chromium")
  assert.equal(summary.savedPath, path.join(downloadsDir, "data (1).csv"))
  const states = events
    .filter((event) => event.type === "download.updated")
    .map((event) => event.download.state)
  assert.deepEqual(states, ["in_progress", "in_progress", "completed"])

  const target = path.join(downloadsDir, "chosen.csv")
  assert.equal((await service.saveDownload("s1", summary.id, target)).state, "saved")
  assert.deepEqual(await service.deleteDownload("s1", summary.id), {
    deleted: true,
    id: summary.id,
  })
  await assert.rejects(() => fs.stat(path.join(downloadsDir, "data (1).csv")), { code: "ENOENT" })
  await assert.rejects(
    () => service.cancelDownload("s1", "missing"),
    (error) => error.code === "browser_download_not_found"
  )
})

test("local pdf prints through CDP into the downloads directory", async (t) => {
  const { service, chromium, downloadsDir } = await fixture(t)
  await service.createSession({ id: "s1", downloadsDir, headless: false })
  const context = chromium.launches[0].context
  const page = context._pages[0]
  await page.goto("https://docs.example.com/guide")
  page._title = "Guide: intro"
  const first = await service.pdf("s1", { landscape: true, scale: 0.8, pageRanges: "1-2" })
  const second = await service.pdf("s1", {})
  assert.equal(first.path, path.join(downloadsDir, "Guide_ intro.pdf"))
  assert.equal(second.path, path.join(downloadsDir, "Guide_ intro (1).pdf"))
  assert.equal(await fs.readFile(first.path, "utf8"), "%PDF-1.7")
  assert.equal(first.download.state, "completed")
  const printCall = context.cdpSessions
    .flatMap(({ cdp }) => cdp.commands)
    .find(([method]) => method === "Page.printToPDF")
  assert.deepEqual(printCall[1], {
    transferMode: "ReturnAsBase64",
    landscape: true,
    printBackground: true,
    preferCSSPageSize: false,
    scale: 0.8,
    pageRanges: "1-2",
  })
  await assert.rejects(
    () => service.pdf("s1", { scale: 9 }),
    (error) => error.code === "browser_option_invalid"
  )
  await assert.rejects(
    () => service.pdf("s1", { pageRanges: "1; rm" }),
    (error) => error.code === "browser_option_invalid"
  )
})

test("extensions.reload restarts local sessions keeping their tabs", async (t) => {
  const { service, chromium, events } = await fixture(t)
  await service.createSession({ id: "s1", extensionPaths: ["/ext/one"] })
  const firstContext = chromium.launches[0].context
  await firstContext._pages[0].goto("https://a.example/")
  const second = await service.createPage("s1", "https://b.example/")
  const frames = []
  await service.startScreencast("s1", (frame) => frames.push(frame))
  assert.equal(second.active, true)

  const result = await service.reloadExtensions(["/ext/one", "/ext/two"])
  assert.deepEqual(result, { reloaded: ["s1"] })
  assert.equal(firstContext.closed, true)
  assert.equal(service.sessions.has("s1"), true)
  const relaunch = chromium.launches[1]
  assert.ok(relaunch.options.args.includes("--load-extension=/ext/one,/ext/two"))
  const pages = await service.listPages("s1")
  assert.deepEqual(
    pages.map((page) => [page.url, page.active]),
    [
      ["https://a.example/", false],
      ["https://b.example/", true],
    ]
  )
  assert.ok(service.sessions.get("s1").screencast, "screencast restarted")
  const changed = events.find((event) => event.type === "extensions.changed")
  assert.deepEqual(changed, {
    kind: "browser.event",
    type: "extensions.changed",
    sessionId: "s1",
    extensionCount: 2,
  })
  assert.equal(
    events.some((event) => event.type === "session.closed"),
    false
  )
  await assert.rejects(
    () => service.reloadExtensions(["relative"]),
    (error) => error.code === "browser_session_option_invalid"
  )
})

test("extension.open opens popup/options pages as tabs and validates ids and paths", async (t) => {
  const { service } = await fixture(t)
  await service.createSession({ id: "s1" })
  const id = "abcdefghijklmnopabcdefghijklmnop"
  const opened = await service.openExtensionPage("s1", {
    extensionId: id,
    page: "popup",
    path: "popup/index.html",
  })
  assert.equal(opened.url, `chrome-extension://${id}/popup/index.html`)
  assert.equal(opened.active, true)
  for (const [payload, code] of [
    [{ extensionId: "UPPERCASE", page: "popup", path: "p.html" }, "extension_not_found"],
    [{ extensionId: id, page: "background", path: "p.html" }, "browser_option_invalid"],
    [{ extensionId: id, page: "options", path: "../../etc/passwd" }, "browser_option_invalid"],
    [{ extensionId: id, page: "options", path: "/abs.html" }, "browser_option_invalid"],
    [{ extensionId: id, page: "options", path: "a\\b.html" }, "browser_option_invalid"],
    [{ extensionId: id, page: "options", path: "javascript:alert(1)" }, "browser_option_invalid"],
  ]) {
    await assert.rejects(
      () => service.openExtensionPage("s1", payload),
      (error) => error.code === code,
      JSON.stringify(payload)
    )
  }
})

test("file:// navigation follows the session's allowFileUrls", async (t) => {
  const { service } = await fixture(t)
  await service.createSession({ id: "blocked", profileId: "a" })
  await assert.rejects(
    () => service.navigate("blocked", "file:///tmp/index.html"),
    (error) => error.code === "file_url_blocked"
  )
  await service.createSession({ id: "allowed", profileId: "b", allowFileUrls: true })
  await service.navigate("allowed", "file:///tmp/index.html")
  assert.equal((await service.getPage("allowed")).url, "file:///tmp/index.html")
})

test("local uploads are confined to uploadRoots", async (t) => {
  const { service, chromium, root } = await fixture(t)
  const uploads = path.join(root, "uploads")
  await fs.mkdir(uploads)
  await fs.writeFile(path.join(uploads, "cv.pdf"), "cv")
  await fs.writeFile(path.join(root, "secret.txt"), "no")
  await service.createSession({ id: "s1", uploadRoots: [uploads] })
  const page = chromium.launches[0].context._pages[0]
  page.mainFrame.evaluate = async () =>
    JSON.stringify({
      url: "https://x.example/",
      title: "x",
      nodes: [{ ref: "e1", role: "button", name: "Upload", tag: "input", type: "file" }],
    })
  const snapshot = await service.snapshot("s1")
  const result = await service.setFiles("s1", snapshot.nodes[0].ref, [path.join(uploads, "cv.pdf")])
  assert.equal(result.ok, true)
  await assert.rejects(
    () => service.setFiles("s1", snapshot.nodes[0].ref, [path.join(root, "secret.txt")]),
    (error) => error.code === "browser_upload_path_denied"
  )
})

test("local file choosers are published and answered only with staged uploads", async (t) => {
  const { service, chromium, root, events } = await fixture(t)
  const uploads = path.join(root, "uploads")
  await fs.mkdir(uploads)
  await fs.writeFile(path.join(uploads, "a.pdf"), "a")
  await fs.writeFile(path.join(uploads, "b.pdf"), "b")
  await fs.writeFile(path.join(root, "secret.txt"), "no")
  await service.createSession({ id: "s1", uploadRoots: [uploads] })
  const page = chromium.launches[0].context._pages[0]
  const chooser = (multiple) => ({
    files: null,
    isMultiple: () => multiple,
    async setFiles(paths) {
      this.files = paths
    },
  })

  const single = chooser(false)
  page.emit("filechooser", single)
  const opened = events.filter((event) => event.type === "filechooser.opened").at(-1)
  assert.deepEqual(opened, {
    kind: "browser.event",
    type: "filechooser.opened",
    sessionId: "s1",
    pageId: pageIdOf(service, "s1", page),
    chooserId: opened.chooserId,
    multiple: false,
  })
  await assert.rejects(
    () => service.setFileChooserFiles("s1", "other", [path.join(uploads, "a.pdf")]),
    (error) => error.code === "browser_file_chooser_not_found"
  )
  await assert.rejects(
    () =>
      service.setFileChooserFiles("s1", opened.chooserId, [
        path.join(uploads, "a.pdf"),
        path.join(uploads, "b.pdf"),
      ]),
    (error) => error.code === "browser_upload_invalid"
  )
  // One answer per chooser: the failed one is gone.
  await assert.rejects(
    () => service.setFileChooserFiles("s1", opened.chooserId, [path.join(uploads, "a.pdf")]),
    (error) => error.code === "browser_file_chooser_not_found"
  )

  const denied = chooser(true)
  page.emit("filechooser", denied)
  const deniedId = events.filter((event) => event.type === "filechooser.opened").at(-1).chooserId
  await assert.rejects(
    () => service.setFileChooserFiles("s1", deniedId, [path.join(root, "secret.txt")]),
    (error) => error.code === "browser_upload_path_denied"
  )
  assert.equal(denied.files, null)

  const multi = chooser(true)
  page.emit("filechooser", multi)
  const multiId = events.filter((event) => event.type === "filechooser.opened").at(-1).chooserId
  const result = await service.setFileChooserFiles("s1", multiId, [
    path.join(uploads, "a.pdf"),
    path.join(uploads, "b.pdf"),
  ])
  assert.deepEqual(result, { ok: true, cancelled: false })
  assert.equal(multi.files.length, 2)

  const cancelled = chooser(false)
  page.emit("filechooser", cancelled)
  const cancelledId = events.filter((event) => event.type === "filechooser.opened").at(-1).chooserId
  assert.deepEqual(await service.setFileChooserFiles("s1", cancelledId, []), {
    ok: true,
    cancelled: true,
  })
  assert.equal(cancelled.files, null)

  // A closed page drops its chooser.
  page.emit("filechooser", chooser(false))
  const closedId = events.filter((event) => event.type === "filechooser.opened").at(-1).chooserId
  page.emit("close")
  await assert.rejects(
    () => service.setFileChooserFiles("s1", closedId, []),
    (error) => error.code === "browser_file_chooser_not_found"
  )
})

test("sessions without upload roots never intercept file choosers", async (t) => {
  const { service, chromium, events } = await fixture(t)
  await service.createSession({ id: "s1" })
  const page = chromium.launches[0].context._pages[0]
  assert.equal(page.listenerCount("filechooser"), 0)
  assert.equal(
    events.some((event) => event.type === "filechooser.opened"),
    false
  )
  await assert.rejects(
    () => service.setFileChooserFiles("s1", "x", []),
    (error) => error.code === "browser_file_chooser_not_found"
  )
})

test("cookies: set is privileged and never echoed, list returns metadata only, clear by domain", async (t) => {
  const { service, chromium } = await fixture(t)
  await service.createSession({ id: "s1" })
  const context = chromium.launches[0].context
  const result = await service.setCookies("s1", [
    {
      name: "sid",
      value: "top-secret-1",
      domain: ".example.com",
      secure: true,
      sameSite: "no_restriction",
    },
    { name: "pref", value: "top-secret-2", domain: "app.example.com", sameSite: "none" },
    { name: "reject-me", value: "x", domain: "example.com" },
    {
      name: "other",
      value: "top-secret-3",
      domain: "other.test",
      expires: 1900000000,
      httpOnly: true,
      sameSite: "Strict",
    },
  ])
  assert.deepEqual(result, { set: 3, skipped: 1 })
  assert.doesNotMatch(JSON.stringify(result), /top-secret/)
  assert.deepEqual(context.cookieJar[0], {
    name: "sid",
    value: "top-secret-1",
    domain: ".example.com",
    path: "/",
    expires: -1,
    secure: true,
    httpOnly: false,
    sameSite: "None",
  })
  // SameSite=None without Secure would be rejected by Chromium: it degrades to Lax.
  assert.equal(context.cookieJar[1].sameSite, "Lax")

  const listed = await service.listCookies("s1", { domain: "example.com" })
  assert.deepEqual(
    listed.cookies.map((cookie) => cookie.name),
    ["sid", "pref"]
  )
  assert.doesNotMatch(JSON.stringify(listed), /top-secret/)
  assert.equal("value" in listed.cookies[0], false)
  assert.equal((await service.listCookies("s1")).cookies.length, 3)

  assert.deepEqual(await service.clearCookies("s1", { domain: "example.com" }), { cleared: 2 })
  assert.ok(context.clearFilter.domain.test("app.example.com"))
  assert.equal(context.clearFilter.domain.test("notexample.com"), false)
  assert.deepEqual(
    context.cookieJar.map((cookie) => cookie.name),
    ["other"]
  )
  assert.deepEqual(await service.clearCookies("s1"), { cleared: 1 })
  await assert.rejects(
    () => service.setCookies("s1", [{ name: "a", value: "b" }]),
    (error) => error.code === "browser_cookie_invalid"
  )
})

test("detects login forms with opaque refs and fills only same-origin forms", async (t) => {
  const { service, chromium } = await fixture(t)
  await service.createSession({ id: "s1" })
  const page = chromium.launches[0].context._pages[0]
  await page.goto("https://login.example.com/signin")
  const iframe = new FakeFrame(page, "https://evil.example.net/frame")
  iframe.loginForms = [{ key: "lf1", hasUsername: true }]
  const evilPassword = new FakeElement()
  iframe.loginElements.set("lf1:p", evilPassword)
  page.childFrames = [iframe]
  page.mainFrame.loginForms = [{ key: "lf1", hasUsername: true }]
  const username = new FakeElement()
  const password = new FakeElement()
  page.mainFrame.loginElements.set("lf1:u", username)
  page.mainFrame.loginElements.set("lf1:p", password)

  const detected = await service.detectLoginForms("s1")
  assert.equal(detected.forms.length, 2)
  assert.deepEqual(Object.keys(detected.forms[0]).sort(), [
    "origin",
    "passwordRef",
    "ref",
    "usernameRef",
  ])
  assert.equal(detected.forms[0].origin, "https://login.example.com")
  assert.equal(detected.forms[1].origin, "https://evil.example.net")
  assert.notEqual(detected.forms[0].passwordRef, "lf1:p")

  const filled = await service.fillCredential("s1", {
    username: "ada@example.com",
    password: "correct horse",
  })
  assert.deepEqual(filled, { filled: true, username: "ada@example.com" })
  assert.doesNotMatch(JSON.stringify(filled), /correct horse/)
  assert.deepEqual(username.filled, ["ada@example.com"])
  assert.deepEqual(password.filled, ["correct horse"])
  assert.deepEqual(evilPassword.filled, [])
  assert.equal(password.disposed, true)
  assert.equal(service.sessions.get("s1").humanKeyboardInputOccurred, true)

  page.mainFrame.loginForms = []
  // Only the cross-origin iframe has a form: nothing is filled.
  assert.deepEqual(await service.fillCredential("s1", { username: "a", password: "b" }), {
    filled: false,
    username: null,
    reason: "origin_mismatch",
  })
  assert.deepEqual(evilPassword.filled, [])
  page.childFrames = []
  assert.deepEqual(await service.fillCredential("s1", { username: "a", password: "b" }), {
    filled: false,
    username: null,
    reason: "no_login_form",
  })
  await assert.rejects(
    () => service.fillCredential("s1", { username: "a", password: "" }),
    (error) => error.code === "browser_credential_invalid"
  )
})

test("credential capture publishes one sensitive credential.submitted per submission", async (t) => {
  const { service, chromium, events } = await fixture(t, { now: () => 1_000 })
  await service.createSession({ id: "s1" })
  const context = chromium.launches[0].context
  const page = context._pages[0]
  await page.goto("https://login.example.com/")
  const binding = context.bindings.get(CREDENTIAL_BINDING)
  const source = { frame: page.mainFrame, page }
  binding(source, { username: "ada", password: "pw-1" })
  binding(source, { username: "ada", password: "pw-1" })
  binding(source, { username: "ada", password: "" })
  binding({ frame: { url: () => "file:///x" }, page }, { username: "a", password: "b" })
  binding(source, { username: 7, password: "pw-2" })
  const submitted = events.filter((event) => event.type === "credential.submitted")
  assert.deepEqual(submitted, [
    {
      kind: "browser.event",
      type: "credential.submitted",
      sessionId: "s1",
      pageId: pageIdOf(service, "s1", page),
      origin: "https://login.example.com",
      username: "ada",
      password: "pw-1",
      sensitive: true,
    },
    {
      kind: "browser.event",
      type: "credential.submitted",
      sessionId: "s1",
      pageId: pageIdOf(service, "s1", page),
      origin: "https://login.example.com",
      username: "",
      password: "pw-2",
      sensitive: true,
    },
  ])
})

test("the capture script hides the binding before page scripts run", () => {
  assert.match(CREDENTIAL_CAPTURE_SCRIPT, /delete window\[name\]/)
  assert.match(CREDENTIAL_CAPTURE_SCRIPT, new RegExp(CREDENTIAL_BINDING))
})

test("emulate applies page-scoped overrides and reset drops them", async (t) => {
  const { service, chromium } = await fixture(t)
  await service.createSession({ id: "s1" })
  const context = chromium.launches[0].context
  const page = context._pages[0]
  await page.goto("https://maps.example.com/")
  const result = await service.emulate("s1", {
    device: "Pixel 7",
    colorScheme: "dark",
    locale: "de-DE",
    timezone: "Europe/Berlin",
    geolocation: { latitude: 52.52, longitude: 13.405 },
    offline: true,
  })
  assert.deepEqual(result.applied, [
    "viewport",
    "device",
    "userAgent",
    "locale",
    "timezone",
    "colorScheme",
    "geolocation",
    "offline",
  ])
  assert.deepEqual(page.viewport, { width: 412, height: 839 })
  assert.deepEqual(page.media, [{ colorScheme: "dark" }])
  const emulation = context.cdpSessions.find(({ cdp }) =>
    cdp.commands.some(([method]) => method === "Emulation.setUserAgentOverride")
  ).cdp
  assert.deepEqual(
    emulation.commands.map(([method]) => method),
    [
      "Emulation.setDeviceMetricsOverride",
      "Emulation.setTouchEmulationEnabled",
      "Emulation.setUserAgentOverride",
      "Emulation.setLocaleOverride",
      "Emulation.setTimezoneOverride",
      "Emulation.setGeolocationOverride",
      "Network.emulateNetworkConditions",
    ]
  )
  assert.deepEqual(context.permissions, [[["geolocation"], { origin: "https://maps.example.com" }]])
  assert.deepEqual(await service.emulate("s1", { reset: true }), { ok: true, applied: ["reset"] })
  assert.equal(emulation.detached, true)
  assert.deepEqual(page.viewport, { width: 1280, height: 720 })

  for (const [options, code] of [
    [{ device: "Nokia 3310" }, "browser_device_unknown"],
    [{ timezone: "Mars/Olympus" }, "browser_option_invalid"],
    [{ locale: "not a locale!!" }, "browser_option_invalid"],
    [{ colorScheme: "sepia" }, "browser_option_invalid"],
    [{ geolocation: { latitude: 200, longitude: 0 } }, "browser_option_invalid"],
    [{ offline: "yes" }, "browser_option_invalid"],
  ]) {
    await assert.rejects(
      () => service.emulate("s1", options),
      (error) => error.code === code,
      JSON.stringify(options)
    )
  }
})

test("storage get/set/clear operate on the page origin; loopback origins return values", async (t) => {
  const { service, chromium } = await fixture(t)
  await service.createSession({ id: "s1" })
  const page = chromium.launches[0].context._pages[0]
  await page.goto("http://localhost:3000/")
  assert.deepEqual(await service.storageSet("s1", { area: "local", key: "theme", value: "dark" }), {
    origin: "http://localhost:3000",
    key: "theme",
  })
  await service.storageSet("s1", { area: "local", key: "obj", value: { a: 1 } })
  assert.deepEqual(await service.storageGet("s1", { area: "local", key: "theme" }), {
    origin: "http://localhost:3000",
    key: "theme",
    value: "dark",
  })
  assert.deepEqual(await service.storageGet("s1", { area: "local" }), {
    origin: "http://localhost:3000",
    entries: { theme: "dark", obj: '{"a":1}' },
  })
  assert.deepEqual(await service.storageGet("s1", { area: "session" }), {
    origin: "http://localhost:3000",
    entries: {},
  })
  assert.deepEqual(await service.storageClear("s1", { area: "local" }), {
    origin: "http://localhost:3000",
    cleared: 2,
  })
  await assert.rejects(
    () => service.storageGet("s1", { area: "cookies" }),
    (error) => error.code === "browser_storage_invalid"
  )
  await assert.rejects(
    () => service.storageSet("s1", { area: "local", key: "" }),
    (error) => error.code === "browser_storage_invalid"
  )
  page.mainFrame.storageThrows = true
  await assert.rejects(
    () => service.storageGet("s1", { area: "local" }),
    (error) => error.code === "browser_storage_unavailable"
  )
})

test("isLoopbackOrigin accepts 127/8, ::1, localhost and *.localhost only", () => {
  for (const origin of [
    "http://localhost:3000",
    "http://LOCALHOST",
    "http://app.localhost:5173",
    "http://127.0.0.1:8080",
    "http://127.10.20.30",
    "http://[::1]:4000",
  ]) {
    assert.equal(isLoopbackOrigin(origin), true, origin)
  }
  for (const origin of [
    "https://app.example.com",
    "http://localhost.example.com",
    "http://128.0.0.1",
    "http://127.0.0.1.nip.io",
    "http://[::2]",
    "http://10.0.0.1",
    "null",
    undefined,
  ]) {
    assert.equal(isLoopbackOrigin(origin), false, String(origin))
  }
})

test("storage.get withholds values on non-loopback origins and returns keys only", async (t) => {
  const { service, chromium } = await fixture(t)
  await service.createSession({ id: "s1" })
  const page = chromium.launches[0].context._pages[0]
  await page.goto("https://app.example.com/")
  await service.storageSet("s1", { area: "local", key: "token", value: "top-secret-token" })
  await service.storageSet("s1", { area: "local", key: "theme", value: "dark" })

  const all = await service.storageGet("s1", { area: "local" })
  assert.deepEqual(all, {
    origin: "https://app.example.com",
    keys: ["token", "theme"],
    entries: { token: null, theme: null },
    valuesWithheld: true,
  })
  assert.doesNotMatch(JSON.stringify(all), /top-secret|dark/)

  assert.deepEqual(await service.storageGet("s1", { area: "local", key: "token" }), {
    origin: "https://app.example.com",
    key: "token",
    value: null,
    exists: true,
    valuesWithheld: true,
  })
  assert.deepEqual(await service.storageGet("s1", { area: "local", key: "missing" }), {
    origin: "https://app.example.com",
    key: "missing",
    value: null,
    exists: false,
    valuesWithheld: true,
  })
})

test("storage.get is refused for user-chrome sessions", async (t) => {
  const { service, chromium } = await fixture(t)
  await service.createSession({
    id: "uc",
    kind: "user-chrome",
    cdpEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
  })
  const page = chromium.connections[0].context._pages.at(-1)
  await page.goto("http://localhost:3000/")
  await assert.rejects(
    () => service.storageGet("uc", { area: "local" }),
    (error) => error.code === "browser_feature_unsupported"
  )
})

test("evaluate is refused after human keyboard input or a credential fill", async (t) => {
  const { service, chromium } = await fixture(t)
  await service.createSession({ id: "typed" })
  await chromium.launches[0].context._pages[0].goto("http://localhost:3000/")
  assert.equal((await service.evaluate("typed", "1 + 1")).ok, true)
  await service.dispatchInput("typed", {
    kind: "key",
    payload: { type: "keyDown", key: "a" },
  })
  await assert.rejects(
    () => service.evaluate("typed", "document.body.innerHTML"),
    (error) => error.code === "browser_human_input_required"
  )

  await service.closeSession("typed")
  await service.createSession({ id: "filled" })
  const page = chromium.launches[1].context._pages[0]
  await page.goto("http://localhost:3000/login")
  page.mainFrame.loginForms = [{ key: "lf1", hasUsername: false }]
  page.mainFrame.loginElements.set("lf1:p", new FakeElement())
  assert.equal((await service.fillCredential("filled", { password: "pw" })).filled, true)
  await assert.rejects(
    () => service.evaluate("filled", "document.querySelector('input').value"),
    (error) => error.code === "browser_human_input_required"
  )
})

function fakeExchange({ url, headers, responseHeaders, body, status = 200 }) {
  const request = {
    url: () => url,
    method: () => "POST",
    allHeaders: async () => headers,
  }
  return {
    request: () => request,
    status: () => status,
    ok: () => status < 400,
    allHeaders: async () => responseHeaders,
    body: async () => body,
  }
}

test("network.request returns redacted headers and a truncated body", async (t) => {
  const { service, chromium } = await fixture(t)
  await service.createSession({ id: "s1" })
  const page = chromium.launches[0].context._pages[0]
  page.emit(
    "response",
    fakeExchange({
      url: "https://api.example.com/v1/items?page=2",
      headers: { Authorization: "Bearer abc", cookie: "sid=1", accept: "application/json" },
      responseHeaders: { "set-cookie": "sid=2", "content-type": "application/json" },
      body: Buffer.alloc(70 * 1024, "x"),
    })
  )
  const [entry] = await service.readNetwork("s1")
  assert.equal(entry.id, "r1")
  const details = await service.networkRequest("s1", entry.id)
  assert.equal(details.url, "https://api.example.com/v1/items?page=2")
  assert.equal(details.method, "POST")
  assert.equal(details.status, 200)
  assert.deepEqual(details.requestHeaders, {
    Authorization: "[REDACTED]",
    cookie: "[REDACTED]",
    accept: "application/json",
  })
  assert.deepEqual(details.responseHeaders, {
    "set-cookie": "[REDACTED]",
    "content-type": "application/json",
  })
  assert.equal(details.truncated, true)
  assert.equal(details.body.length, 64 * 1024)
  assert.equal(details.bodyEncoding, "utf8")
  await assert.rejects(
    () => service.networkRequest("s1", "r999"),
    (error) => error.code === "browser_request_not_found"
  )

  // After imported cookies were set, bodies are withheld (the query stays).
  await service.setCookies("s1", [{ name: "sid", value: "v", domain: ".example.com" }])
  const afterCookies = await service.networkRequest("s1", entry.id)
  assert.equal(afterCookies.url, "https://api.example.com/v1/items?page=2")
  assert.equal(afterCookies.body, null)
  assert.equal(afterCookies.bodyEncoding, null)
  assert.equal(afterCookies.bodyRedacted, true)
  assert.deepEqual(afterCookies.requestHeaders, details.requestHeaders)

  // After human keyboard input the body and query are withheld.
  service.sessions.get("s1").humanKeyboardInputOccurred = true
  const redacted = await service.networkRequest("s1", entry.id)
  assert.equal(redacted.url, "https://api.example.com/v1/items")
  assert.equal(redacted.body, null)
  assert.equal(redacted.bodyRedacted, true)
})

test("imported cookies mark the profile so later sessions on it withhold bodies until an unscoped clear", async (t) => {
  const { service, chromium, root } = await fixture(t)
  const marker = path.join(root, "profiles", "default", COOKIES_IMPORTED_MARKER)
  const bodyOf = async (sessionId) => {
    const page = chromium.launches.at(-1).context._pages[0]
    page.emit(
      "response",
      fakeExchange({
        url: "https://api.example.com/me",
        headers: {},
        responseHeaders: { "content-type": "application/json" },
        body: Buffer.from('{"account":"private"}'),
      })
    )
    const entries = await service.readNetwork(sessionId)
    return service.networkRequest(sessionId, entries.at(-1).id)
  }

  await service.createSession({ id: "s1" })
  assert.equal((await bodyOf("s1")).body, '{"account":"private"}')
  await assert.rejects(() => fs.stat(marker), { code: "ENOENT" })
  // An empty import sets nothing and writes no marker.
  await service.setCookies("s1", [])
  await assert.rejects(() => fs.stat(marker), { code: "ENOENT" })
  await service.setCookies("s1", [{ name: "sid", value: "v", domain: ".example.com" }])
  assert.equal((await fs.stat(marker)).isFile(), true)
  assert.equal((await fs.stat(marker)).mode & 0o777, 0o600)
  await service.closeSession("s1")

  // A new session on the same profile inherits the withholding.
  await service.createSession({ id: "s2" })
  const inherited = await bodyOf("s2")
  assert.equal(inherited.body, null)
  assert.equal(inherited.bodyRedacted, true)
  // A domain-scoped clear leaves other imported cookies, so the marker stays.
  await service.clearCookies("s2", { domain: "example.com" })
  assert.equal((await fs.stat(marker)).isFile(), true)
  // An unscoped clear removes every cookie and the marker; this session keeps
  // withholding because it may hold responses captured while authenticated.
  await service.clearCookies("s2")
  await assert.rejects(() => fs.stat(marker), { code: "ENOENT" })
  assert.equal((await bodyOf("s2")).bodyRedacted, true)
  await service.closeSession("s2")

  await service.createSession({ id: "s3" })
  assert.equal((await bodyOf("s3")).body, '{"account":"private"}')
  await service.closeSession("s3")

  // The marker is per profile: another profile is unaffected.
  await service.createSession({ id: "s4" })
  await service.setCookies("s4", [{ name: "sid", value: "v", domain: ".example.com" }])
  await service.closeSession("s4")
  await service.createSession({ id: "w1", profileId: "work" })
  assert.equal((await bodyOf("w1")).body, '{"account":"private"}')
  await service.closeSession("w1")
  await service.createSession({ id: "s5" })
  assert.equal((await bodyOf("s5")).bodyRedacted, true)
})

test("user-chrome attaches over CDP, opens agent tabs in a new window, and finalize closes only them", async (t) => {
  const { service, chromium, events } = await fixture(t)
  const summary = await service.createSession({
    id: "uc",
    kind: "user-chrome",
    cdpEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
  })
  assert.equal(summary.kind, "user-chrome")
  assert.equal(summary.profileId, null)
  assert.equal(summary.pages.length, 1)
  const [connection] = chromium.connections
  assert.deepEqual(connection.options, { timeout: 120_000 })
  const userTabs = connection.context._pages.slice(0, 2)
  const [control, downloads] = connection.browser.cdpSessions
  assert.deepEqual(control.commands.at(-1)[0], "Target.createTarget")
  assert.deepEqual(control.commands.at(-1)[1], { url: "about:blank", newWindow: true })
  assert.deepEqual(downloads.commands[0], [
    "Browser.setDownloadBehavior",
    { behavior: "default", eventsEnabled: true },
  ])
  // The overlay goes into agent tabs only, never the user's context.
  assert.deepEqual(connection.context.initScripts, [])
  assert.equal(connection.context.bindings.size, 0)
  const agentTab = connection.context._pages[2]
  assert.deepEqual(agentTab.initScripts, ["window.__overlay = true"])

  const second = await service.createPage("uc", "https://news.example.com/")
  assert.equal(second.url, "https://news.example.com/")
  assert.deepEqual(control.commands.at(-2), [
    "Target.activateTarget",
    { targetId: agentTab.targetId },
  ])
  assert.deepEqual(control.commands.at(-1)[1], { url: "about:blank" })

  // A popup opened by an agent tab joins the session; the user's new tab does not.
  const popup = new FakePage(connection.context)
  popup._opener = agentTab
  connection.context._pages.push(popup)
  connection.context.emit("page", popup)
  const userNewTab = new FakePage(connection.context)
  connection.context._pages.push(userNewTab)
  connection.context.emit("page", userNewTab)
  await tick()
  assert.equal((await service.listPages("uc")).length, 3)

  // Downloads from the user's own tabs are not tracked; agent-tab downloads are.
  downloads.emit("Browser.downloadWillBegin", {
    guid: "user",
    url: "https://x/a",
    suggestedFilename: "a",
    frameId: userTabs[0].targetId,
  })
  downloads.emit("Browser.downloadWillBegin", {
    guid: "agent",
    url: "https://x/b.zip",
    suggestedFilename: "b.zip",
    frameId: agentTab.targetId,
  })
  const tracked = service.listDownloads("uc")
  assert.deepEqual(
    tracked.map((item) => [item.filename, item.backend]),
    [["b.zip", "user-chrome"]]
  )
  await service.cancelDownload("uc", tracked[0].id)
  assert.deepEqual(downloads.commands.at(-1), ["Browser.cancelDownload", { guid: "agent" }])

  await assert.rejects(
    () => service.clearCookies("uc"),
    (error) => error.code === "browser_feature_unsupported"
  )
  await assert.rejects(
    () => service.setCookies("uc", []),
    (error) => error.code === "browser_feature_unsupported"
  )
  await assert.rejects(
    () =>
      service.openExtensionPage("uc", {
        extensionId: "abcdefghijklmnopabcdefghijklmnop",
        page: "popup",
        path: "p.html",
      }),
    (error) => error.code === "extensions_unsupported_backend"
  )

  assert.deepEqual(await service.finalizeTabs("uc"), { closed: 3 })
  assert.deepEqual(connection.context._pages, [...userTabs, userNewTab])
  assert.equal(
    userTabs.every((page) => !page.closed),
    true
  )

  await service.closeSession("uc")
  assert.equal(connection.browser.closed, true, "disconnects")
  assert.equal(connection.context.closed, false, "never closes the user's context")
  assert.equal(events.at(-1).type, "session.closed")
})

test("user-chrome connection failures are typed and leave no session", async (t) => {
  const { service } = await fixture(t)
  await assert.rejects(
    () =>
      service.createSession({
        id: "uc",
        kind: "user-chrome",
        cdpEndpoint: "ws://127.0.0.1:9999/devtools/browser/abc",
      }),
    (error) => error.code === "browser_user_chrome_connect_failed"
  )
  assert.equal(service.sessions.size, 0)
})

test("user-chrome sessions never capture credentials", async (t) => {
  const { service, chromium, events } = await fixture(t)
  await service.createSession({
    id: "uc",
    kind: "user-chrome",
    cdpEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
  })
  const connection = chromium.connections[0]
  const agentTab = connection.context._pages[2]
  service.onCredentialSubmitted(
    service.sessions.get("uc"),
    { frame: { url: () => "https://login.example.com/" }, page: agentTab },
    { username: "a", password: "b" }
  )
  assert.equal(
    events.some((event) => event.type === "credential.submitted"),
    false
  )
})

test("finalize is refused for launched local Chromium", async (t) => {
  const { service } = await fixture(t)
  await service.createSession({ id: "s1" })
  await assert.rejects(
    () => service.finalizeTabs("s1"),
    (error) => error.code === "browser_feature_unsupported"
  )
})
