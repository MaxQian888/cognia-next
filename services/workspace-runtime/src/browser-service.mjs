import fs from "node:fs/promises"
import path from "node:path"

import { encodeMediaFrame } from "./protocol.mjs"
import { NetworkPolicy } from "./network-policy.mjs"

const SECRET_FIELD =
  /password|passcode|one[\s-]?time|otp|token|secret|verification[\s-]?code|密码|口令|验证码/i

export class RemoteBrowserError extends Error {
  constructor(code, message) {
    super(message)
    this.name = "RemoteBrowserError"
    this.code = code
  }
}

function parseEnvelope(value) {
  return typeof value === "string" ? JSON.parse(value) : value
}

function pageMainFrame(page) {
  return typeof page.mainFrame === "function" ? page.mainFrame() : page.mainFrame
}

function pageSummary(record, pageId, activePageId) {
  return Promise.all([record.page.title(), Promise.resolve(record.page.url())]).then(
    ([title, url]) => ({
      id: pageId,
      url,
      title,
      active: pageId === activePageId,
    })
  )
}

function assertProfileId(profileId) {
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(profileId)) {
    throw new RemoteBrowserError("browser_profile_invalid", "Browser profile id is invalid")
  }
}

export class RemoteChromiumService {
  constructor({
    chromium,
    overlayScript,
    workspaceRoot,
    profilesRoot,
    fileBridge,
    createId = () => crypto.randomUUID(),
    networkPolicyFactory = () => new NetworkPolicy(),
    maxSessions = 3,
    maxPages = 8,
    idleTimeoutMs = 30 * 60 * 1000,
    maxLifetimeMs = 8 * 60 * 60 * 1000,
    reaperIntervalMs = 60 * 1000,
    now = () => Date.now(),
    viewport = { width: 1280, height: 720 },
  }) {
    this.chromium = chromium
    this.overlayScript = overlayScript
    this.workspaceRoot = path.resolve(workspaceRoot)
    this.profilesRoot = path.resolve(profilesRoot)
    this.fileBridge = fileBridge
    this.createId = createId
    this.networkPolicyFactory = networkPolicyFactory
    this.maxSessions = maxSessions
    this.maxPages = maxPages
    this.idleTimeoutMs = idleTimeoutMs
    this.maxLifetimeMs = maxLifetimeMs
    this.now = now
    this.viewport = {
      width: Math.min(viewport.width, 1600),
      height: Math.min(viewport.height, 1200),
    }
    this.sessions = new Map()
    this.profileOwners = new Map()
    this.references = new Map()
    this.reaper = setInterval(() => void this.reapExpired(), reaperIntervalMs)
    this.reaper.unref?.()
  }

  async createSession({ id, profileId = null, grants = [] }) {
    await this.fileBridge.ready
    if (this.sessions.has(id))
      throw new RemoteBrowserError("browser_session_exists", "Session exists")
    if (this.sessions.size >= this.maxSessions) {
      throw new RemoteBrowserError("browser_session_quota_exceeded", "Session quota exceeded")
    }
    if (profileId) {
      assertProfileId(profileId)
      if (this.profileOwners.has(profileId)) {
        throw new RemoteBrowserError("browser_profile_in_use", "Browser profile is in use")
      }
    }

    const policy = this.networkPolicyFactory()
    const resolverRules = await policy.resolverRules(grants)
    const browserLaunchOptions = {
      headless: true,
      args: [
        `--host-resolver-rules=${resolverRules}`,
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    }
    const contextOptions = { viewport: this.viewport, acceptDownloads: true }
    let browser = null
    let context
    if (profileId) {
      const profilePath = path.join(this.profilesRoot, profileId)
      await fs.mkdir(profilePath, { recursive: true, mode: 0o700 })
      context = await this.chromium.launchPersistentContext(profilePath, {
        ...browserLaunchOptions,
        ...contextOptions,
      })
      this.profileOwners.set(profileId, id)
    } else {
      browser = await this.chromium.launch(browserLaunchOptions)
      context = await browser.newContext(contextOptions)
    }

    const createdAt = this.now()
    const session = {
      id,
      profileId,
      grants: [...grants],
      policy,
      browser,
      context,
      pages: new Map(),
      pageIds: new WeakMap(),
      activePageId: null,
      console: [],
      network: [],
      blockedDomains: new Set(),
      lastBlockedError: null,
      screencast: null,
      humanKeyboardInputOccurred: false,
      pendingDialog: null,
      pendingAction: null,
      dialogWaiters: new Set(),
      actionInFlight: false,
      closing: false,
      createdAt,
      lastActivityAt: createdAt,
    }
    this.sessions.set(id, session)
    await context.addInitScript(this.overlayScript)
    await context.route("**/*", async (route) => this.authorizeRoute(session, route))
    context.on("page", (page) => this.registerPage(session, page))
    context.on("close", () => {
      void this.handleConnectionClosed(session).catch(() => undefined)
    })
    browser?.on?.("disconnected", () => {
      void this.handleConnectionClosed(session).catch(() => undefined)
    })
    const firstPage = await context.newPage()
    this.registerPage(session, firstPage)
    return this.summary(id)
  }

  async authorizeRoute(session, route) {
    const request = route.request()
    try {
      await session.policy.authorize(request.url(), session.grants)
      await route.continue()
    } catch (error) {
      if (error.hostname) session.blockedDomains.add(error.hostname)
      session.lastBlockedError = error
      await route.abort("blockedbyclient")
    }
  }

  registerPage(session, page) {
    const existing = session.pageIds.get(page)
    if (existing) return existing
    if (session.pages.size >= this.maxPages) {
      void page.close()
      return null
    }
    const pageId = this.createId()
    const record = { page, generation: 0, cdp: null }
    session.pageIds.set(page, pageId)
    session.pages.set(pageId, record)
    session.activePageId = pageId
    page.on("close", () => {
      void this.dismissPendingDialog(session, pageId).catch(() => undefined)
      session.pages.delete(pageId)
      this.invalidatePage(session.id, pageId)
      if (session.activePageId === pageId) {
        session.activePageId = session.pages.keys().next().value ?? null
      }
    })
    page.on("dialog", (dialog) => {
      if (session.pendingDialog) {
        void dialog.dismiss().catch(() => undefined)
        return
      }
      const pending = {
        dialog,
        pageId,
        metadata: {
          type: dialog.type(),
          message: dialog.message(),
          defaultValue: dialog.defaultValue(),
        },
      }
      session.pendingDialog = pending
      for (const resolve of session.dialogWaiters) resolve(pending)
    })
    page.on("console", (message) => {
      const type = message.type()
      const text = message.text()
      session.console.push({
        level: ["log", "info", "warn", "error", "debug"].includes(type) ? type : "log",
        text: session.humanKeyboardInputOccurred || SECRET_FIELD.test(text) ? "[REDACTED]" : text,
        ts: Date.now(),
      })
    })
    const started = new WeakMap()
    page.on("request", (request) => started.set(request, Date.now()))
    page.on("response", (response) => {
      const request = response.request()
      const requestUrl = new URL(request.url())
      if (session.humanKeyboardInputOccurred) {
        requestUrl.search = ""
        requestUrl.hash = ""
      }
      session.network.push({
        url: requestUrl.toString(),
        method: request.method(),
        status: response.status(),
        ok: response.ok(),
        durationMs: started.has(request) ? Date.now() - started.get(request) : null,
      })
    })
    page.on("download", async (download) => {
      try {
        const downloadPath = await download.path()
        if (!downloadPath) return
        const bytes = await fs.readFile(downloadPath)
        await this.fileBridge.quarantineDownload(session.id, download.suggestedFilename(), bytes)
      } catch {
        // Download failures surface through the browser action/diagnostic path.
      }
    })
    return pageId
  }

  async summary(sessionId) {
    const session = this.requireSession(sessionId)
    return {
      id: session.id,
      profileId: session.profileId,
      pages: await this.listPages(sessionId),
      activePageId: session.activePageId,
      blockedDomains: [...session.blockedDomains],
    }
  }

  async listPages(sessionId) {
    const session = this.requireSession(sessionId)
    return Promise.all(
      [...session.pages.entries()].map(([pageId, record]) =>
        pageSummary(record, pageId, session.activePageId)
      )
    )
  }

  async activatePage(sessionId, pageId) {
    const session = this.requireSession(sessionId)
    this.assertNoPendingDialog(session)
    const record = session.pages.get(pageId)
    if (!record) throw new RemoteBrowserError("browser_page_not_found", "Page not found")
    await record.page.bringToFront()
    session.activePageId = pageId
  }

  async closePage(sessionId, pageId) {
    const session = this.requireSession(sessionId)
    this.assertNoPendingDialog(session)
    const record = session.pages.get(pageId)
    if (!record) throw new RemoteBrowserError("browser_page_not_found", "Page not found")
    await record.page.close()
  }

  async createPage(sessionId, url = "about:blank") {
    const session = this.requireSession(sessionId)
    if (session.pages.size >= this.maxPages) {
      throw new RemoteBrowserError("browser_page_quota_exceeded", "Page quota exceeded")
    }
    if (url !== "about:blank") await session.policy.authorize(url, session.grants)
    return this.runActionWithDialog(session, 0, async () => {
      const page = await session.context.newPage()
      const pageId = this.registerPage(session, page)
      if (!pageId)
        throw new RemoteBrowserError("browser_page_quota_exceeded", "Page quota exceeded")
      if (url !== "about:blank") await page.goto(url, { waitUntil: "domcontentloaded" })
      session.activePageId = pageId
      const record = session.pages.get(pageId)
      return pageSummary(record, pageId, pageId)
    })
  }

  async navigate(sessionId, url) {
    const session = this.requireSession(sessionId)
    const { page, record } = this.activeRecord(session)
    const fromUrl = page.url()
    await session.policy.authorize(url, session.grants)
    return this.runActionWithDialog(session, record.generation, async () => {
      session.lastBlockedError = null
      try {
        await page.goto(url, { waitUntil: "domcontentloaded" })
      } catch (error) {
        if (session.lastBlockedError) throw session.lastBlockedError
        throw error
      }
      try {
        await session.policy.authorizeRedirect(fromUrl, page.url(), session.grants)
      } catch (error) {
        await page.evaluate(() => window.stop()).catch(() => undefined)
        throw error
      }
      this.invalidatePage(session.id, session.activePageId)
      await this.applyZoom(session)
      return { ok: true, error: null, generation: record.generation }
    })
  }

  async snapshot(sessionId, options = {}) {
    const session = this.requireSession(sessionId)
    const { pageId, record } = this.activeRecord(session)
    record.generation += 1
    this.invalidatePage(sessionId, pageId)
    const nodes = []
    let url = record.page.url()
    let title = await record.page.title()
    const mainFrame = pageMainFrame(record.page)
    for (const frame of record.page.frames()) {
      let frameSnapshot
      try {
        frameSnapshot = parseEnvelope(
          await frame.evaluate(({ includeText }) => window.__cogniaSnapshot({ includeText }), {
            includeText: !!options.includeText,
          })
        )
      } catch {
        continue
      }
      if (frame === mainFrame) {
        url = frameSnapshot.url || url
        title = frameSnapshot.title || title
      }
      for (const node of frameSnapshot.nodes ?? []) {
        if (SECRET_FIELD.test(`${node.name} ${node.tag} ${node.type ?? ""}`)) continue
        const opaqueRef = this.createId()
        this.references.set(opaqueRef, {
          sessionId,
          pageId,
          generation: record.generation,
          frame,
          nativeRef: node.ref,
        })
        nodes.push({
          ...node,
          ref: opaqueRef,
          value: node.value,
          ...(frame === mainFrame ? {} : { frame: true }),
        })
      }
    }
    return {
      generation: record.generation,
      url,
      title,
      nodes,
      blockedDomains: [...session.blockedDomains],
    }
  }

  async act(sessionId, reference, action, args) {
    const session = this.requireSession(sessionId)
    const generation = this.activeRecord(session).record.generation
    const modifiers = Array.isArray(args?.modifiers)
      ? args.modifiers.map((modifier) => {
          const value = String(modifier).toLowerCase()
          if (value === "ctrl" || value === "control") return "Control"
          if (value === "cmd" || value === "meta") return "Meta"
          if (value === "alt" || value === "option") return "Alt"
          if (value === "shift") return "Shift"
          return String(modifier)
        })
      : []
    const clickOptions = modifiers.length ? { modifiers } : undefined
    return this.runActionWithDialog(session, generation, async () => {
      const { element, dispose } = await this.resolveTarget(session, reference)
      try {
        if (
          await element.evaluate((node) => {
            const descriptor = [
              node.getAttribute?.("type"),
              node.getAttribute?.("name"),
              node.id,
              node.getAttribute?.("autocomplete"),
              node.getAttribute?.("placeholder"),
              node.getAttribute?.("aria-label"),
            ].join(" ")
            return /password|passcode|one[\s-]?time|otp|token|secret|verification[\s-]?code|密码|口令|验证码/i.test(
              descriptor
            )
          })
        ) {
          throw new RemoteBrowserError(
            "browser_human_input_required",
            "Credential fields require human takeover"
          )
        }
        if (action === "click") await element.click(clickOptions)
        else if (action === "double_click") await element.dblclick(clickOptions)
        else if (action === "hover") await element.hover()
        else if (action === "focus") await element.focus()
        else if (action === "fill") await element.fill(String(args?.text ?? ""))
        else if (action === "type") await element.pressSequentially(String(args?.text ?? ""))
        else if (action === "select") await element.selectOption(args?.value)
        else if (action === "key") await element.press(String(args?.key ?? ""))
        else if (action === "scroll") await element.scrollIntoViewIfNeeded()
        else throw new RemoteBrowserError("browser_action_invalid", "Unsupported browser action")
        return { ok: true, error: null, generation }
      } finally {
        await dispose()
      }
    })
  }

  async drag(sessionId, sourceRef, targetRef) {
    const session = this.requireSession(sessionId)
    const generation = this.activeRecord(session).record.generation
    return this.runActionWithDialog(session, generation, async () => {
      const source = await this.resolveTarget(session, sourceRef)
      const target = await this.resolveTarget(session, targetRef)
      if (source.generation !== target.generation) {
        await Promise.allSettled([source.dispose(), target.dispose()])
        throw new RemoteBrowserError("browser_stale_ref", "Browser reference is stale")
      }
      try {
        await source.element.dragTo(target.element)
        return { ok: true, error: null, generation: source.generation }
      } finally {
        await Promise.allSettled([source.dispose(), target.dispose()])
      }
    })
  }

  async handleDialog(sessionId, { accept, promptText } = {}) {
    const session = this.requireSession(sessionId)
    const pending = session.pendingDialog
    if (!pending) {
      throw new RemoteBrowserError("browser_dialog_not_found", "No browser dialog is pending")
    }
    const action = session.pendingAction
    try {
      if (accept) await pending.dialog.accept(promptText)
      else await pending.dialog.dismiss()
      let actionError = null
      if (action) {
        try {
          await action
        } catch (error) {
          actionError = error instanceof Error ? error.message : String(error)
        }
      }
      const record = session.pages.get(pending.pageId)
      return {
        ok: actionError === null,
        error: actionError,
        generation: record?.generation ?? 0,
      }
    } finally {
      session.pendingDialog = null
      session.pendingAction = null
      session.actionInFlight = false
    }
  }

  async pressKey(sessionId, key, reference = "") {
    if (reference) return this.act(sessionId, reference, "key", { key })
    const session = this.requireSession(sessionId)
    const { page, record } = this.activeRecord(session)
    return this.runActionWithDialog(session, record.generation, async () => {
      const sensitive = await page.evaluate(() => {
        const element = document.activeElement
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
          return false
        }
        const descriptor = [
          element.type,
          element.name,
          element.id,
          element.autocomplete,
          element.placeholder,
          element.getAttribute("aria-label"),
        ].join(" ")
        return /password|passcode|one[\s-]?time|otp|token|secret|verification[\s-]?code|密码|口令|验证码/i.test(
          descriptor
        )
      })
      if (sensitive) {
        throw new RemoteBrowserError(
          "browser_human_input_required",
          "Credential fields require human takeover"
        )
      }
      await page.keyboard.press(key)
      return { ok: true, error: null, generation: record.generation }
    })
  }

  async scroll(sessionId, { reference = "", direction = "down", amount = 600 }) {
    if (reference) return this.act(sessionId, reference, "scroll", { direction, amount })
    const session = this.requireSession(sessionId)
    const { page, record } = this.activeRecord(session)
    const edgeDelta = 10_000_000
    const x = direction === "left" ? -amount : direction === "right" ? amount : 0
    const y =
      direction === "top"
        ? -edgeDelta
        : direction === "bottom"
          ? edgeDelta
          : direction === "up"
            ? -amount
            : direction === "down"
              ? amount
              : 0
    return this.runActionWithDialog(session, record.generation, async () => {
      await page.mouse.wheel(x, y)
      return { ok: true, error: null, generation: record.generation }
    })
  }

  async evaluate(sessionId, expression) {
    const session = this.requireSession(sessionId)
    const { page, record } = this.activeRecord(session)
    const hostname = new URL(page.url()).hostname
    if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
      return { ok: false, error: "browser_evaluate is disabled on public origins" }
    }
    return this.runActionWithDialog(session, record.generation, async () => {
      try {
        return {
          ok: true,
          value: await page.evaluate((source) => globalThis.eval(source), expression),
        }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    })
  }

  async getPage(sessionId) {
    const session = this.requireSession(sessionId)
    const { page } = this.activeRecord(session)
    return { url: page.url(), title: await page.title() }
  }

  // CSS `zoom` reflows into the JPEG screencast (unlike CDP setPageScaleFactor,
  // which is pinch-only). It resets on navigation, so `applyZoom` re-applies the
  // session's factor after every navigate/history.
  async setZoom(sessionId, zoom) {
    const session = this.requireSession(sessionId)
    const { page, record } = this.activeRecord(session)
    const numeric = Number(zoom)
    const factor = Number.isFinite(numeric) ? Math.min(5, Math.max(0.25, numeric)) : 1
    return this.runActionWithDialog(session, record.generation, async () => {
      session.zoom = factor
      await page.evaluate((value) => {
        document.documentElement.style.zoom = String(value)
      }, factor)
      return { ok: true, zoom: factor }
    })
  }

  async applyZoom(session) {
    const factor = session.zoom
    if (!factor || factor === 1) return
    try {
      const { page } = this.activeRecord(session)
      await page.evaluate((value) => {
        document.documentElement.style.zoom = String(value)
      }, factor)
    } catch {
      // Page may be mid-navigation; the next navigate re-applies.
    }
  }

  // Find-in-page runs the injected `__cogniaFind` helper directly (NOT the
  // localhost-gated `evaluate`), so it works on any origin the session allows.
  async find(sessionId, query, options = {}) {
    const session = this.requireSession(sessionId)
    this.assertNoPendingDialog(session)
    const { page } = this.activeRecord(session)
    return page.evaluate((args) => window.__cogniaFind(args.query, args.options || {}), {
      query: String(query ?? ""),
      options: options ?? {},
    })
  }

  async findClear(sessionId) {
    const session = this.requireSession(sessionId)
    this.assertNoPendingDialog(session)
    const { page } = this.activeRecord(session)
    await page.evaluate(() => window.__cogniaFindClear())
    return { ok: true }
  }

  async readConsole(sessionId) {
    const session = this.requireSession(sessionId)
    return session.console.splice(0)
  }

  async readNetwork(sessionId) {
    const session = this.requireSession(sessionId)
    return session.network.splice(0)
  }

  async history(sessionId, operation) {
    const session = this.requireSession(sessionId)
    const { pageId, page, record } = this.activeRecord(session)
    return this.runActionWithDialog(session, record.generation, async () => {
      await page[operation]({ waitUntil: "domcontentloaded" })
      this.invalidatePage(sessionId, pageId)
      await this.applyZoom(session)
      return { ok: true, error: null, generation: record.generation }
    })
  }

  back(sessionId) {
    return this.history(sessionId, "goBack")
  }

  forward(sessionId) {
    return this.history(sessionId, "goForward")
  }

  reload(sessionId) {
    return this.history(sessionId, "reload")
  }

  async stop(sessionId) {
    const session = this.requireSession(sessionId)
    const { page, record } = this.activeRecord(session)
    return this.runActionWithDialog(session, record.generation, async () => {
      await page.evaluate(() => window.stop())
      return { ok: true, error: null, generation: record.generation }
    })
  }

  async waitForText(sessionId, text, options = {}) {
    const page = this.activeRecord(this.requireSession(sessionId)).page
    return this.waitFor(() =>
      page.getByText(text, { exact: false }).waitFor({
        state: options.mode === "disappear" ? "hidden" : "visible",
        timeout: options.timeoutMs ?? 5000,
      })
    )
  }

  async waitForSelector(sessionId, selector, options = {}) {
    const page = this.activeRecord(this.requireSession(sessionId)).page
    return this.waitFor(() =>
      page.locator(selector).waitFor({
        state: options.mode === "disappear" ? "hidden" : "visible",
        timeout: options.timeoutMs ?? 5000,
      })
    )
  }

  async waitForNetworkIdle(sessionId, options = {}) {
    const page = this.activeRecord(this.requireSession(sessionId)).page
    return this.waitFor(() =>
      page.waitForLoadState("networkidle", { timeout: options.timeoutMs ?? 10000 })
    )
  }

  async waitForLoad(sessionId, options = {}) {
    const page = this.activeRecord(this.requireSession(sessionId)).page
    return this.waitFor(() => page.waitForLoadState("load", { timeout: options.timeoutMs ?? 8000 }))
  }

  async waitFor(callback) {
    try {
      await callback()
      return { ok: true, timedOut: false }
    } catch (error) {
      if (String(error).toLowerCase().includes("timeout")) return { ok: false, timedOut: true }
      throw error
    }
  }

  async screenshot(sessionId, options = {}) {
    const session = this.requireSession(sessionId)
    const { page } = this.activeRecord(session)
    const scope = options.scope ?? (options.ref ? "element" : "viewport")
    if (scope === "element") {
      if (!options.ref) {
        throw new RemoteBrowserError(
          "browser_screenshot_ref_required",
          "Element screenshot requires a ref"
        )
      }
      const target = await this.resolveTarget(session, options.ref)
      try {
        const [bytes, box] = await Promise.all([
          target.element.screenshot({ type: "png" }),
          target.element.boundingBox(),
        ])
        if (!box)
          throw new RemoteBrowserError("browser_element_not_visible", "Element is not visible")
        return {
          bytes: bytes.toString("base64"),
          width: Math.round(box.width),
          height: Math.round(box.height),
          capturedAt: Date.now(),
          format: "png",
        }
      } finally {
        await target.dispose()
      }
    }
    const bytes = await page.screenshot({
      type: "png",
      ...(scope === "fullPage" ? { fullPage: true } : {}),
    })
    const viewport =
      scope === "fullPage"
        ? await page.evaluate(() => ({
            width: Math.max(
              document.documentElement.scrollWidth,
              document.body?.scrollWidth ?? 0,
              window.innerWidth
            ),
            height: Math.max(
              document.documentElement.scrollHeight,
              document.body?.scrollHeight ?? 0,
              window.innerHeight
            ),
          }))
        : (page.viewportSize() ?? this.viewport)
    return {
      bytes: bytes.toString("base64"),
      width: viewport.width,
      height: viewport.height,
      capturedAt: Date.now(),
      format: "png",
    }
  }

  async setFiles(sessionId, reference, relativePaths) {
    const session = this.requireSession(sessionId)
    const { pageId, record } = this.activeRecord(session)
    const paths = await this.fileBridge.resolveUploads(relativePaths)
    return this.runActionWithDialog(session, record.generation, async () => {
      const target = this.references.get(reference)
      if (
        !target ||
        target.sessionId !== sessionId ||
        target.pageId !== pageId ||
        target.generation !== record.generation
      ) {
        throw new RemoteBrowserError("browser_stale_ref", "Browser reference is stale")
      }
      const handle = await target.frame.evaluateHandle(
        (ref) => window.__cogniaOverlay.resolveRef(ref),
        target.nativeRef
      )
      const element = handle.asElement()
      if (!element) {
        await handle.dispose()
        throw new RemoteBrowserError("browser_invalid_file_target", "Ref is not an element")
      }
      try {
        await element.setInputFiles(paths)
        return { ok: true, error: null, generation: record.generation }
      } finally {
        await handle.dispose()
      }
    })
  }

  listDownloads(sessionId) {
    this.requireSession(sessionId)
    return this.fileBridge.listDownloads(sessionId)
  }

  async startScreencast(sessionId, onFrame, { quality = 70 } = {}) {
    const session = this.requireSession(sessionId)
    const { page } = this.activeRecord(session)
    if (session.screencast) await this.stopScreencast(sessionId)
    const cdp = await session.context.newCDPSession(page)
    const state = { cdp, sequence: 0, pending: null }
    session.screencast = state
    cdp.on("Page.screencastFrame", async (event) => {
      if (state.pending) return
      state.sequence += 1
      state.pending = { sequence: state.sequence, cdpSessionId: event.sessionId }
      const viewport = page.viewportSize() ?? this.viewport
      await onFrame(
        encodeMediaFrame({
          sequence: state.sequence,
          width: viewport.width,
          height: viewport.height,
          timestamp: Date.now(),
          jpeg: Buffer.from(event.data, "base64"),
        })
      )
    })
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: Math.max(60, Math.min(80, quality)),
      maxWidth: 1600,
      maxHeight: 1200,
      everyNthFrame: 1,
    })
  }

  async ackScreencastFrame(sessionId, sequence) {
    const state = this.requireSession(sessionId).screencast
    if (!state?.pending || state.pending.sequence !== sequence) return false
    await state.cdp.send("Page.screencastFrameAck", { sessionId: state.pending.cdpSessionId })
    state.pending = null
    return true
  }

  async stopScreencast(sessionId) {
    const session = this.requireSession(sessionId)
    if (!session.screencast) return
    await session.screencast.cdp.send("Page.stopScreencast")
    await session.screencast.cdp.detach()
    session.screencast = null
  }

  async dispatchInput(sessionId, input) {
    const session = this.requireSession(sessionId)
    this.assertNoPendingDialog(session)
    const { page } = this.activeRecord(session)
    const cdp = await session.context.newCDPSession(page)
    try {
      if (input.kind === "mouse") {
        await cdp.send("Input.dispatchMouseEvent", input.payload)
      } else if (input.kind === "key") {
        session.humanKeyboardInputOccurred = true
        await cdp.send("Input.dispatchKeyEvent", input.payload)
      } else {
        throw new RemoteBrowserError("browser_input_invalid", "Unsupported input kind")
      }
    } finally {
      await cdp.detach()
    }
  }

  async cancelAction(sessionId) {
    const session = this.requireSession(sessionId)
    const { page } = this.activeRecord(session)
    await Promise.allSettled([page.keyboard.press("Escape"), page.evaluate(() => window.stop())])
  }

  async closeSession(sessionId) {
    const session = this.requireSession(sessionId)
    session.closing = true
    await this.stopScreencast(sessionId)
    await this.dismissPendingDialog(session)
    this.invalidateSession(sessionId)
    await session.context.close()
    if (session.browser) await session.browser.close()
    await this.fileBridge.cleanupSession(sessionId)
    this.sessions.delete(sessionId)
    if (session.profileId && this.profileOwners.get(session.profileId) === sessionId) {
      this.profileOwners.delete(session.profileId)
    }
  }

  async handleConnectionClosed(session) {
    if (session.closing || !this.sessions.has(session.id)) return
    session.closing = true
    await this.dismissPendingDialog(session)
    this.invalidateSession(session.id)
    await this.fileBridge.cleanupSession(session.id)
    this.sessions.delete(session.id)
    if (session.profileId && this.profileOwners.get(session.profileId) === session.id) {
      this.profileOwners.delete(session.profileId)
    }
  }

  async closeAll() {
    clearInterval(this.reaper)
    for (const sessionId of [...this.sessions.keys()]) await this.closeSession(sessionId)
  }

  async reapExpired(at = this.now()) {
    const expired = [...this.sessions.values()]
      .filter(
        (session) =>
          at - session.lastActivityAt >= this.idleTimeoutMs ||
          at - session.createdAt >= this.maxLifetimeMs
      )
      .map((session) => session.id)
    await Promise.allSettled(expired.map((sessionId) => this.closeSession(sessionId)))
    return expired
  }

  activeRecord(session) {
    const pageId = session.activePageId
    const record = pageId ? session.pages.get(pageId) : null
    if (!record) throw new RemoteBrowserError("browser_page_not_found", "No active page")
    return { pageId, record, page: record.page }
  }

  assertNoPendingDialog(session) {
    if (session.pendingDialog) {
      throw new RemoteBrowserError(
        "browser_dialog_pending",
        "Handle the pending browser dialog before performing another action"
      )
    }
  }

  async resolveTarget(session, reference) {
    const { pageId, record } = this.activeRecord(session)
    const target = this.references.get(reference)
    if (
      !target ||
      target.sessionId !== session.id ||
      target.pageId !== pageId ||
      target.generation !== record.generation
    ) {
      throw new RemoteBrowserError("browser_stale_ref", "Browser reference is stale")
    }
    const handle = await target.frame.evaluateHandle(
      (ref) => window.__cogniaOverlay.resolveRef(ref),
      target.nativeRef
    )
    const element = handle.asElement()
    if (!element) {
      await handle.dispose()
      throw new RemoteBrowserError("browser_invalid_target", "Browser ref is not an element")
    }
    return {
      element,
      generation: record.generation,
      dispose: () => handle.dispose(),
    }
  }

  async runActionWithDialog(session, generation, action) {
    this.assertNoPendingDialog(session)
    if (session.actionInFlight) {
      throw new RemoteBrowserError(
        "browser_action_in_progress",
        "Another browser action is still in progress"
      )
    }
    session.actionInFlight = true
    let resolveDialog
    const dialogPromise = new Promise((resolve) => {
      resolveDialog = resolve
    })
    session.dialogWaiters.add(resolveDialog)
    const actionPromise = Promise.resolve().then(action)
    let keepActionInFlight = false
    try {
      const outcome = await Promise.race([
        actionPromise.then((result) => ({ kind: "action", result })),
        dialogPromise.then((pending) => ({ kind: "dialog", pending })),
      ])
      if (outcome.kind === "dialog") {
        session.pendingAction = actionPromise
        keepActionInFlight = true
        void actionPromise.catch(() => undefined)
        return {
          ok: true,
          error: null,
          generation,
          dialogPending: true,
          dialog: outcome.pending.metadata,
        }
      }
      return outcome.result
    } finally {
      session.dialogWaiters.delete(resolveDialog)
      if (!keepActionInFlight) session.actionInFlight = false
    }
  }

  async dismissPendingDialog(session, pageId) {
    const pending = session.pendingDialog
    if (!pending || (pageId && pending.pageId !== pageId)) return
    try {
      await pending.dialog.dismiss()
      if (session.pendingAction) await Promise.allSettled([session.pendingAction])
    } finally {
      session.pendingDialog = null
      session.pendingAction = null
      session.actionInFlight = false
    }
  }

  requireSession(sessionId) {
    const session = this.sessions.get(sessionId)
    if (!session) throw new RemoteBrowserError("browser_session_not_found", "Session not found")
    session.lastActivityAt = this.now()
    return session
  }

  invalidatePage(sessionId, pageId) {
    for (const [reference, target] of this.references) {
      if (target.sessionId === sessionId && target.pageId === pageId)
        this.references.delete(reference)
    }
  }

  invalidateSession(sessionId) {
    for (const [reference, target] of this.references) {
      if (target.sessionId === sessionId) this.references.delete(reference)
    }
  }
}
