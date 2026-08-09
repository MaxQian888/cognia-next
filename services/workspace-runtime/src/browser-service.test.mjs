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
    this.resolvedRefs = []
  }
  async evaluateHandle(_fn, ref) {
    this.resolvedRefs.push(ref)
    return this.page.elements.get(ref) ?? new FakeElement(ref, this.page)
  }
  url() {
    return this._url
  }
  async evaluate(fn, argument) {
    if (String(fn).includes("__cogniaFindClear")) {
      await this.page.triggerDialog("nextFindDialog")
      return { ok: true }
    }
    if (String(fn).includes("__cogniaFind")) {
      await this.page.triggerDialog("nextFindDialog")
      return { matches: 2, index: 0 }
    }
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

class FakeDialog {
  constructor(type = "confirm", message = "Continue?", defaultValue = "") {
    this._type = type
    this._message = message
    this._defaultValue = defaultValue
    this.handled = new Promise((resolve) => {
      this.resolveHandled = resolve
    })
  }
  type() {
    return this._type
  }
  message() {
    return this._message
  }
  defaultValue() {
    return this._defaultValue
  }
  async accept(text) {
    this.accepted = text ?? true
    this.resolveHandled()
  }
  async dismiss() {
    this.dismissed = true
    this.resolveHandled()
  }
}

class FakeElement {
  constructor(ref, page) {
    this.ref = ref
    this.page = page
    this.calls = []
  }
  asElement() {
    return this
  }
  async evaluate() {
    return false
  }
  async dispose() {}
  async click(options) {
    this.calls.push(["click", options])
    if (this.blockClick) await this.blockClick
    if (this.nextDialog) {
      const dialog = this.nextDialog
      this.nextDialog = null
      this.page.emit("dialog", dialog)
      await dialog.handled
    }
  }
  async dblclick(options) {
    this.calls.push(["dblclick", options])
  }
  async hover() {
    this.calls.push(["hover"])
  }
  async focus() {
    this.calls.push(["focus"])
  }
  async fill(text) {
    this.calls.push(["fill", text])
  }
  async pressSequentially(text) {
    this.calls.push(["pressSequentially", text])
  }
  async selectOption(value) {
    this.calls.push(["selectOption", value])
  }
  async press(key) {
    this.calls.push(["press", key])
  }
  async scrollIntoViewIfNeeded() {
    this.calls.push(["scrollIntoViewIfNeeded"])
  }
  async dragTo(target) {
    this.calls.push(["dragTo", target.ref])
  }
  async screenshot() {
    this.calls.push(["screenshot"])
    return Buffer.from("element-png")
  }
  async boundingBox() {
    return { x: 1, y: 2, width: 30, height: 40 }
  }
}

class FakePage extends EventEmitter {
  constructor(url = "http://localhost:3000/") {
    super()
    this._url = url
    this._title = "App"
    this._closed = false
    this.mainFrame = new FakeFrame(url)
    this.mainFrame.page = this
    this.elements = new Map([
      ["e1", new FakeElement("e1", this)],
      ["e2", new FakeElement("e2", this)],
    ])
    this.pressedKeys = []
    this.wheelEvents = []
    this.keyboard = {
      press: async (key) => {
        this.pressedKeys.push(key)
        if (this.nextKeyDialog) {
          const dialog = this.nextKeyDialog
          this.nextKeyDialog = null
          this.emit("dialog", dialog)
          await dialog.handled
        }
      },
    }
    this.mouse = {
      wheel: async (deltaX, deltaY) => this.wheelEvents.push([deltaX, deltaY]),
    }
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
    const dialog = await this.triggerDialog("nextNavigationDialog")
    if (dialog?.dismissed && this.rejectNavigationOnDismiss) {
      throw new Error("Navigation interrupted by beforeunload")
    }
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
  screenshot(options) {
    this.screenshotOptions = options
    return Promise.resolve(Buffer.from("png"))
  }
  evaluate(fn, arg) {
    if (String(fn).includes("document.activeElement")) return Promise.resolve(false)
    if (String(fn).includes("document.documentElement.scrollWidth")) {
      return Promise.resolve({ width: 1440, height: 3000 })
    }
    if (String(fn).includes("globalThis.eval")) {
      return this.triggerDialog("nextEvaluateDialog").then(() => ({ ok: true, value: "App" }))
    }
    return this.mainFrame.evaluate(fn, arg)
  }
  async triggerDialog(property) {
    const dialog = this[property]
    if (!dialog) return null
    this[property] = null
    this.emit("dialog", dialog)
    await dialog.handled
    return dialog
  }
  async goBack() {
    await this.triggerDialog("nextNavigationDialog")
  }
  async goForward() {
    await this.triggerDialog("nextNavigationDialog")
  }
  async reload() {
    await this.triggerDialog("nextNavigationDialog")
  }
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
    this.emit("close")
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

test("uses native Playwright element actions for opaque snapshot refs", async (t) => {
  const { service, chromium } = await fixture(t)
  await service.createSession({ id: "session-1", grants: [] })
  const snapshot = await service.snapshot("session-1")
  const page = chromium.launches[0].context.pages[0]
  const ref = snapshot.nodes[0].ref
  await service.act("session-1", ref, "click", { modifiers: ["ctrl"] })
  await service.act("session-1", ref, "double_click", {})
  await service.act("session-1", ref, "focus", {})
  await service.act("session-1", ref, "fill", { text: "Ada" })
  assert.deepEqual(page.elements.get("e1").calls, [
    ["click", { modifiers: ["Control"] }],
    ["dblclick", undefined],
    ["focus"],
    ["fill", "Ada"],
  ])
})

test("keeps cross-frame refs bound to the frame that produced them", async (t) => {
  const { service, chromium } = await fixture(t)
  await service.createSession({ id: "session-1", grants: [] })
  const page = chromium.launches[0].context.pages[0]
  const childFrame = new FakeFrame("https://child.example.com/")
  childFrame.page = page
  page.frames = () => [page.mainFrame, childFrame]

  const snapshot = await service.snapshot("session-1")
  const childRef = snapshot.nodes.find((node) => node.frame)?.ref
  assert(childRef)
  await service.act("session-1", childRef, "focus", {})

  assert.deepEqual(childFrame.resolvedRefs, ["e1"])
  assert.deepEqual(page.mainFrame.resolvedRefs, [])
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

test("creates an active page and performs native drag-and-drop", async (t) => {
  const { service, chromium } = await fixture(t)
  await service.createSession({ id: "session-1", grants: [] })
  const created = await service.createPage("session-1", "https://app.example.com/new")
  assert.equal(created.url, "https://app.example.com/new")
  assert.equal(created.active, true)

  const snapshot = await service.snapshot("session-1")
  await service.drag("session-1", snapshot.nodes[0].ref, snapshot.nodes[0].ref)
  const page = chromium.launches[0].context.pages.at(-1)
  assert.deepEqual(page.elements.get("e1").calls, [["dragTo", "e1"]])
})

test("returns a pending dialog without hanging and resumes the native action after handling", async (t) => {
  const { service, chromium } = await fixture(t)
  await service.createSession({ id: "session-1", grants: [] })
  const snapshot = await service.snapshot("session-1")
  const page = chromium.launches[0].context.pages[0]
  const dialog = new FakeDialog("prompt", "Your name?", "Ada")
  page.elements.get("e1").nextDialog = dialog

  const action = await service.act("session-1", snapshot.nodes[0].ref, "click", {})
  assert.deepEqual(action.dialog, {
    type: "prompt",
    message: "Your name?",
    defaultValue: "Ada",
  })
  assert.equal(action.dialogPending, true)
  await assert.rejects(
    () => service.scroll("session-1", { direction: "down" }),
    (error) => error.code === "browser_dialog_pending"
  )
  await assert.rejects(
    () => service.evaluate("session-1", "document.title"),
    (error) => error.code === "browser_dialog_pending"
  )
  await assert.rejects(
    () => service.find("session-1", "hello"),
    (error) => error.code === "browser_dialog_pending"
  )
  await assert.rejects(
    () => service.findClear("session-1"),
    (error) => error.code === "browser_dialog_pending"
  )
  await assert.rejects(
    () => service.dispatchInput("session-1", { kind: "key", payload: {} }),
    (error) => error.code === "browser_dialog_pending"
  )
  const handled = await service.handleDialog("session-1", { accept: true, promptText: "Grace" })
  assert.equal(handled.ok, true)
  assert.equal(dialog.accepted, "Grace")
})

test("rejects a concurrent dialog-aware action instead of racing pending ownership", async (t) => {
  const { service, chromium } = await fixture(t)
  await service.createSession({ id: "session-1", grants: [] })
  const snapshot = await service.snapshot("session-1")
  const element = chromium.launches[0].context.pages[0].elements.get("e1")
  let releaseClick
  element.blockClick = new Promise((resolve) => {
    releaseClick = resolve
  })

  const firstAction = service.act("session-1", snapshot.nodes[0].ref, "click", {})
  await assert.rejects(
    () => service.pressKey("session-1", "Enter"),
    (error) => error.code === "browser_action_in_progress"
  )
  releaseClick()
  assert.equal((await firstAction).ok, true)
})

test("returns dialog metadata immediately for navigation and resumes after dismissal", async (t) => {
  const { service, chromium } = await fixture(t)
  await service.createSession({ id: "session-1", grants: [] })
  const page = chromium.launches[0].context.pages[0]
  const dialog = new FakeDialog("beforeunload", "Leave this page?")
  page.nextNavigationDialog = dialog
  page.rejectNavigationOnDismiss = true

  const navigation = await service.navigate("session-1", "http://localhost:3000/next")
  assert.equal(navigation.dialogPending, true)
  assert.equal(navigation.dialog.type, "beforeunload")
  const handled = await service.handleDialog("session-1", { accept: false })
  assert.equal(dialog.dismissed, true)
  assert.equal(handled.ok, false)
  assert.equal(handled.error, "Navigation interrupted by beforeunload")
})

test("dismisses pending dialogs when the page closes", async (t) => {
  const { service, chromium } = await fixture(t)
  await service.createSession({ id: "session-1", grants: [] })
  const snapshot = await service.snapshot("session-1")
  const page = chromium.launches[0].context.pages[0]
  const dialog = new FakeDialog()
  page.elements.get("e1").nextDialog = dialog

  await service.act("session-1", snapshot.nodes[0].ref, "click", {})
  await page.close()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(dialog.dismissed, true)
})

test("returns dialog metadata for a page-level key action", async (t) => {
  const { service, chromium } = await fixture(t)
  await service.createSession({ id: "session-1", grants: [] })
  const page = chromium.launches[0].context.pages[0]
  const dialog = new FakeDialog("alert", "Submitted")
  page.nextKeyDialog = dialog

  const result = await service.pressKey("session-1", "Enter")

  assert.equal(result.dialogPending, true)
  assert.deepEqual(result.dialog, {
    type: "alert",
    message: "Submitted",
    defaultValue: "",
  })
  await service.handleDialog("session-1", { accept: false })
})

test("dismisses pending dialogs when the session closes", async (t) => {
  const { service, chromium } = await fixture(t)
  await service.createSession({ id: "session-1", grants: [] })
  const snapshot = await service.snapshot("session-1")
  const page = chromium.launches[0].context.pages[0]
  const dialog = new FakeDialog()
  page.elements.get("e1").nextDialog = dialog

  await service.act("session-1", snapshot.nodes[0].ref, "click", {})
  await service.closeSession("session-1")

  assert.equal(dialog.dismissed, true)
})

test("dismisses pending dialogs and drops the session when the connection closes", async (t) => {
  const { service, chromium } = await fixture(t)
  await service.createSession({ id: "session-1", grants: [] })
  const snapshot = await service.snapshot("session-1")
  const page = chromium.launches[0].context.pages[0]
  const dialog = new FakeDialog()
  page.elements.get("e1").nextDialog = dialog

  await service.act("session-1", snapshot.nodes[0].ref, "click", {})
  chromium.launches[0].context.emit("close")
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(dialog.dismissed, true)
  await assert.rejects(
    () => service.listPages("session-1"),
    (error) => error.code === "browser_session_not_found"
  )
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

test("supports full-page and ref-scoped screenshots", async (t) => {
  const { service, chromium } = await fixture(t)
  await service.createSession({ id: "session-1", grants: [] })
  const full = await service.screenshot("session-1", { scope: "fullPage" })
  assert.equal(full.bytes, Buffer.from("png").toString("base64"))
  assert.equal(full.width, 1440)
  assert.equal(full.height, 3000)
  assert.deepEqual(chromium.launches[0].context.pages[0].screenshotOptions, {
    type: "png",
    fullPage: true,
  })

  const snapshot = await service.snapshot("session-1")
  const element = await service.screenshot("session-1", { ref: snapshot.nodes[0].ref })
  assert.equal(element.bytes, Buffer.from("element-png").toString("base64"))
  assert.equal(element.width, 30)
  assert.equal(element.height, 40)
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
  assert.deepEqual(chromium.launches[0].context.pages[0].wheelEvents, [[0, 400]])
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
