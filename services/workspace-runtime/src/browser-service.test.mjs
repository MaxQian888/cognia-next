import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { RemoteChromiumService } from "./browser-service.mjs"
import { WorkspaceFileBridge } from "./file-bridge.mjs"

class FakeFrame {
  constructor(url = "http://localhost:3000/") {
    this._url = url
    this.snapshotGeneration = 0
  }
  url() {
    return this._url
  }
  async evaluate(fn, argument) {
    if (String(fn).includes("__cogniaFindClear")) return { ok: true }
    if (String(fn).includes("__cogniaFind")) return { matches: 2, index: 0 }
    if (argument?.includeText !== undefined) {
      this.snapshotGeneration += 1
      return JSON.stringify({
        generation: this.snapshotGeneration,
        url: this._url,
        title: "App",
        nodes: [
          {
            ref: "e1",
            role: "button",
            name: "Submit",
            tag: "button",
            rect: { x: 1, y: 2, width: 3, height: 4 },
            value: null,
            state: { disabled: false, checked: null, expanded: null },
          },
          {
            ref: "e2",
            role: "textbox",
            name: "One-time password",
            tag: "input",
            rect: { x: 1, y: 2, width: 3, height: 4 },
            value: "123456",
            state: { disabled: false, checked: null, expanded: null },
          },
        ],
      })
    }
    if (argument?.action) return JSON.stringify({ ok: true, error: null, generation: 9 })
    return { ok: true, value: "App" }
  }
}

class FakePage extends EventEmitter {
  constructor(url = "http://localhost:3000/") {
    super()
    this._url = url
    this._title = "App"
    this._closed = false
    this.mainFrame = new FakeFrame(url)
    this.pressedKeys = []
    this.keyboard = { press: async (key) => this.pressedKeys.push(key) }
  }
  url() {
    return this._url
  }
  title() {
    return Promise.resolve(this._title)
  }
  frames() {
    return [this.mainFrame]
  }
  async goto(url) {
    this._url = url
    this.mainFrame._url = url
  }
  async bringToFront() {}
  async close() {
    this._closed = true
    this.emit("close")
  }
  isClosed() {
    return this._closed
  }
  viewportSize() {
    return { width: 1280, height: 720 }
  }
  screenshot() {
    return Promise.resolve(Buffer.from("png"))
  }
  evaluate(fn, arg) {
    if (String(fn).includes("document.activeElement")) return Promise.resolve(false)
    return this.mainFrame.evaluate(fn, arg)
  }
  goBack() {}
  goForward() {}
  reload() {}
  locator() {
    return { waitFor: async () => {} }
  }
  getByText() {
    return { waitFor: async () => {} }
  }
  waitForLoadState() {}
  context() {
    return this._context
  }
}

class FakeContext extends EventEmitter {
  constructor() {
    super()
    this.pages = []
    this.closed = false
  }
  async addInitScript() {}
  async route(_pattern, handler) {
    this.routeHandler = handler
  }
  async newPage() {
    const page = new FakePage()
    page._context = this
    this.pages.push(page)
    this.emit("page", page)
    return page
  }
  async close() {
    this.closed = true
  }
  newCDPSession() {
    return Promise.resolve(new FakeCdp())
  }
}

class FakeCdp extends EventEmitter {
  constructor() {
    super()
    this.commands = []
  }
  async send(method, params) {
    this.commands.push([method, params])
  }
  async detach() {}
}

function fakeChromium() {
  const launches = []
  return {
    launches,
    async launch(options) {
      const context = new FakeContext()
      const browser = { newContext: async () => context, close: async () => {} }
      launches.push({ options, context, browser })
      return browser
    },
    async launchPersistentContext(profilePath, options) {
      const context = new FakeContext()
      launches.push({ options, context, profilePath })
      return context
    },
  }
}

async function fixture(t, options = {}) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cognia-browser-service-"))
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }))
  const chromium = fakeChromium()
  let id = 0
  const service = new RemoteChromiumService({
    chromium,
    overlayScript: "window.__overlay = true",
    workspaceRoot,
    profilesRoot: path.join(workspaceRoot, ".profiles"),
    createId: () => `id-${++id}`,
    networkPolicyFactory: () => ({
      resolverRules: async () => "MAP app.example.com 93.184.216.34,EXCLUDE localhost",
      authorize: async (url) => ({ url, hostname: new URL(url).hostname }),
      authorizeRedirect: async (_from, url) => ({ url }),
    }),
    fileBridge: new WorkspaceFileBridge({ workspaceRoot }),
    ...options,
  })
  return { service, chromium }
}

test("clamps page zoom and re-applies it after navigation", async (t) => {
  const { service } = await fixture(t)
  await service.createSession({ id: "session-1", grants: ["app.example.com"] })
  // Out-of-range zoom saturates to the supported bound.
  assert.deepEqual(await service.setZoom("session-1", 9), { ok: true, zoom: 5 })
  assert.deepEqual(await service.setZoom("session-1", 0.1), { ok: true, zoom: 0.25 })
  // Navigation (which resets CSS zoom) re-applies the session factor cleanly.
  await service.navigate("session-1", "http://localhost:3000/next")
})

test("runs find-in-page via the injected helper, not the gated evaluate", async (t) => {
  const { service } = await fixture(t)
  await service.createSession({ id: "session-1", grants: ["app.example.com"] })
  assert.deepEqual(await service.find("session-1", "hello", { forward: true }), {
    matches: 2,
    index: 0,
  })
  assert.deepEqual(await service.findClear("session-1"), { ok: true })
})

test("creates one isolated context with pinned DNS and a single active page", async (t) => {
  const { service, chromium } = await fixture(t)
  const summary = await service.createSession({ id: "session-1", grants: ["app.example.com"] })
  assert.equal(summary.pages.length, 1)
  assert.equal(summary.activePageId, summary.pages[0].id)
  assert(
    chromium.launches[0].options.args.includes(
      "--host-resolver-rules=MAP app.example.com 93.184.216.34,EXCLUDE localhost"
    )
  )
})

test("snapshot emits opaque refs, redacts credential fields, and expires old generations", async (t) => {
  const { service } = await fixture(t)
  await service.createSession({ id: "session-1", grants: [] })
  const first = await service.snapshot("session-1", { includeText: true })
  assert.equal(first.nodes.length, 1)
  assert.notEqual(first.nodes[0].ref, "e1")
  assert(!JSON.stringify(first).includes("One-time password"))
  assert(!JSON.stringify(first).includes("123456"))
  assert.deepEqual(first.blockedDomains, [])
  await service.act("session-1", first.nodes[0].ref, "click", {})

  await service.snapshot("session-1")
  await assert.rejects(
    () => service.act("session-1", first.nodes[0].ref, "click", {}),
    (error) => error.code === "browser_stale_ref"
  )
})

test("tracks popups as pages and keeps exactly one global active page", async (t) => {
  const { service, chromium } = await fixture(t)
  await service.createSession({ id: "session-1", grants: [] })
  const context = chromium.launches[0].context
  await context.newPage()
  const pages = await service.listPages("session-1")
  assert.equal(pages.length, 2)
  assert.equal(pages.filter((page) => page.active).length, 1)
  await service.activatePage("session-1", pages[0].id)
  assert.equal((await service.listPages("session-1"))[0].active, true)
  await service.closePage("session-1", pages[1].id)
  assert.equal((await service.listPages("session-1")).length, 1)
})

test("human takeover cancels the active page action without closing the session", async (t) => {
  const { service, chromium } = await fixture(t)
  await service.createSession({ id: "session-1", grants: [] })
  const page = chromium.launches[0].context.pages[0]

  await service.cancelAction("session-1")

  assert.deepEqual(page.pressedKeys, ["Escape"])
  assert.equal((await service.listPages("session-1")).length, 1)
})

test("returns PNG screenshots in the host-neutral Screenshot contract", async (t) => {
  const { service } = await fixture(t)
  await service.createSession({ id: "session-1", grants: [] })
  const shot = await service.screenshot("session-1")
  assert.deepEqual(shot, {
    bytes: Buffer.from("png").toString("base64"),
    width: 1280,
    height: 720,
    capturedAt: shot.capturedAt,
    format: "png",
  })
})

test("supports page-level key and scroll actions without an element ref", async (t) => {
  const { service, chromium } = await fixture(t)
  await service.createSession({ id: "session-1", grants: [] })
  assert.deepEqual(await service.pressKey("session-1", "Enter"), {
    ok: true,
    error: null,
    generation: 0,
  })
  assert.deepEqual(await service.scroll("session-1", { direction: "down", amount: 400 }), {
    ok: true,
    error: null,
    generation: 0,
  })
  assert.deepEqual(chromium.launches[0].context.pages[0].pressedKeys, ["Enter"])
})

test("suppresses diagnostics after human keyboard input so credentials cannot enter logs", async (t) => {
  const { service, chromium } = await fixture(t)
  await service.createSession({ id: "session-1", grants: [] })
  const page = chromium.launches[0].context.pages[0]
  await service.dispatchInput("session-1", {
    kind: "key",
    payload: { type: "keyDown", key: "x", text: "x" },
  })
  page.emit("console", { type: () => "log", text: () => "totally-random-secret-value" })
  const request = {
    url: () => "https://example.com/callback?token=totally-random-secret-value",
    method: () => "GET",
  }
  page.emit("response", {
    request: () => request,
    status: () => 200,
    ok: () => true,
  })

  assert.equal((await service.readConsole("session-1"))[0].text, "[REDACTED]")
  assert.equal((await service.readNetwork("session-1"))[0].url, "https://example.com/callback")
})

test("named profiles are exclusive while ephemeral sessions leave no profile", async (t) => {
  const { service, chromium } = await fixture(t)
  await service.createSession({ id: "session-1", profileId: "qa-login", grants: [] })
  assert.match(chromium.launches[0].profilePath, /qa-login$/)
  await assert.rejects(
    () => service.createSession({ id: "session-2", profileId: "qa-login", grants: [] }),
    (error) => error.code === "browser_profile_in_use"
  )
  await service.closeSession("session-1")
  await assert.doesNotReject(() =>
    service.createSession({ id: "session-2", profileId: "qa-login", grants: [] })
  )
})

test("reclaims idle and absolute-lifetime sessions while releasing profiles", async (t) => {
  let now = 1_000
  const { service, chromium } = await fixture(t, {
    now: () => now,
    idleTimeoutMs: 100,
    maxLifetimeMs: 500,
  })
  await service.createSession({ id: "idle", profileId: "idle-profile", grants: [] })
  const idleContext = chromium.launches[0].context
  now += 101
  assert.deepEqual(await service.reapExpired(), ["idle"])
  assert.equal(idleContext.closed, true)

  await service.createSession({ id: "absolute", profileId: "idle-profile", grants: [] })
  now += 400
  await service.listPages("absolute")
  now += 101
  assert.deepEqual(await service.reapExpired(), ["absolute"])
  assert.equal(chromium.launches[1].context.closed, true)
})
