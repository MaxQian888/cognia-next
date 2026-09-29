import crypto from "node:crypto"
import http from "node:http"

import { PRIVATE_PROTOCOL_VERSION, protocolEnvelope } from "./protocol.mjs"

const MAX_CONTROL_BODY_BYTES = 4 * 1024 * 1024

function authorized(request, secret) {
  const value = request.headers.authorization ?? ""
  const expected = `Bearer ${secret}`
  const actualBytes = Buffer.from(value)
  const expectedBytes = Buffer.from(expected)
  return (
    actualBytes.length === expectedBytes.length &&
    crypto.timingSafeEqual(actualBytes, expectedBytes)
  )
}

function json(response, status, value) {
  const body = Buffer.from(JSON.stringify(value))
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  })
  response.end(body)
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_CONTROL_BODY_BYTES) throw new Error("control request is too large")
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

const SENSITIVE_EVENT_FIELDS = ["password"]

/**
 * In-memory event ring served by `GET /v1/events?after=N`.
 *
 * Events published with `sensitive: true` (local-mode `credential.submitted`)
 * carry a secret for exactly one hand-off to the authenticated host: the
 * secret fields are scrubbed as soon as a reader acknowledges the event by
 * polling with `after >= event.sequence`, or after `sensitiveTtlMs`,
 * whichever comes first. The `sensitive` marker itself is never served.
 */
export class RuntimeEventJournal {
  constructor(maxEvents = 512, { sensitiveTtlMs = 60_000, now = () => Date.now() } = {}) {
    this.maxEvents = maxEvents
    this.sensitiveTtlMs = sensitiveTtlMs
    this.now = now
    this.sequence = 0
    this.events = []
    this.sensitive = new Map()
  }

  publish(event) {
    const { sensitive, ...rest } = event
    this.sequence += 1
    const entry = { sequence: this.sequence, timestamp: this.now(), ...rest }
    this.events.push(entry)
    if (sensitive === true) this.sensitive.set(entry.sequence, entry)
    if (this.events.length > this.maxEvents) {
      for (const dropped of this.events.splice(0, this.events.length - this.maxEvents)) {
        this.scrub(dropped)
      }
    }
  }

  scrub(entry) {
    if (!this.sensitive.delete(entry.sequence)) return
    for (const field of SENSITIVE_EVENT_FIELDS) delete entry[field]
    entry.scrubbed = true
  }

  after(sequence) {
    const at = this.now()
    for (const entry of [...this.sensitive.values()]) {
      if (entry.sequence <= sequence || at - entry.timestamp >= this.sensitiveTtlMs) {
        this.scrub(entry)
      }
    }
    return this.events.filter((event) => event.sequence > sequence)
  }
}

function browserAuditMetadata(type, payload = {}) {
  const metadata = {}
  if (typeof payload.sessionId === "string") metadata.sessionId = payload.sessionId
  if (type === "browser.session.create") {
    metadata.sessionId = typeof payload.id === "string" ? payload.id : undefined
    metadata.persistentProfile = typeof payload.profileId === "string"
    metadata.grantedDomains = Array.isArray(payload.grants)
      ? payload.grants.filter((domain) => typeof domain === "string")
      : []
    // Local-mode shape only; never host paths or the DevTools endpoint.
    if (payload.kind === "local" || payload.kind === "user-chrome") metadata.kind = payload.kind
    if (typeof payload.headless === "boolean") metadata.headless = payload.headless
    if (Array.isArray(payload.extensionPaths))
      metadata.extensionCount = payload.extensionPaths.length
    if (typeof payload.allowFileUrls === "boolean") metadata.allowFileUrls = payload.allowFileUrls
  } else if (type === "browser.navigate" && typeof payload.url === "string") {
    try {
      metadata.navigationDomain = new URL(payload.url).hostname
    } catch {
      metadata.navigationDomain = "invalid"
    }
  } else if (type === "browser.act" && typeof payload.action === "string") {
    metadata.action = payload.action
  } else if (type === "browser.files.set" || type === "browser.filechooser.set") {
    metadata.fileCount = Array.isArray(payload.paths) ? payload.paths.length : 0
  } else if (type === "browser.cookies.set") {
    // Never the cookie names, values or domains — only how many were sent.
    metadata.cookieCount = Array.isArray(payload.cookies) ? payload.cookies.length : 0
  } else if (type === "browser.cookies.list" || type === "browser.cookies.clear") {
    metadata.scoped = typeof payload.domain === "string" && payload.domain.length > 0
  } else if (type === "browser.credential.fill") {
    // Never the username or password.
    metadata.pageScoped = typeof payload.pageId === "string"
  } else if (
    type === "browser.storage.get" ||
    type === "browser.storage.set" ||
    type === "browser.storage.clear"
  ) {
    // Never the key or value.
    metadata.area = payload.area === "session" ? "session" : "local"
  } else if (
    type === "browser.download.cancel" ||
    type === "browser.download.delete" ||
    type === "browser.download.save"
  ) {
    if (typeof payload.downloadId === "string") metadata.downloadId = payload.downloadId
  } else if (type === "browser.network.request") {
    if (typeof payload.requestId === "string") metadata.requestId = payload.requestId
  } else if (type === "browser.extension.open") {
    if (typeof payload.extensionId === "string") metadata.extensionId = payload.extensionId
    if (payload.page === "popup" || payload.page === "options")
      metadata.extensionPage = payload.page
  } else if (type === "browser.extensions.reload") {
    metadata.extensionCount = Array.isArray(payload.extensionPaths)
      ? payload.extensionPaths.length
      : 0
  } else if (type === "browser.emulate") {
    metadata.emulated = [
      "device",
      "viewport",
      "userAgent",
      "colorScheme",
      "locale",
      "timezone",
      "geolocation",
      "offline",
      "reset",
    ].filter((field) => payload[field] !== undefined)
  }
  return metadata
}

function createDispatcher(browser, supervisor, media, eventJournal) {
  const operations = {
    "browser.session.create": (payload) => browser.createSession(payload),
    "browser.session.close": ({ sessionId }) => browser.closeSession(sessionId),
    "browser.profile.delete": ({ profileId }) => browser.deleteProfile(profileId),
    "browser.navigate": ({ sessionId, url }) => browser.navigate(sessionId, url),
    "browser.snapshot": ({ sessionId, options }) => browser.snapshot(sessionId, options),
    "browser.act": ({ sessionId, ref, action, args }) =>
      browser.act(sessionId, ref, action, args ?? {}),
    "browser.press-key": ({ sessionId, key, ref }) => browser.pressKey(sessionId, key, ref),
    "browser.scroll": ({ sessionId, ...args }) => browser.scroll(sessionId, args),
    "browser.evaluate": ({ sessionId, expression }) => browser.evaluate(sessionId, expression),
    "browser.console": ({ sessionId }) => browser.readConsole(sessionId),
    "browser.network": ({ sessionId }) => browser.readNetwork(sessionId),
    "browser.back": ({ sessionId }) => browser.back(sessionId),
    "browser.forward": ({ sessionId }) => browser.forward(sessionId),
    "browser.reload": ({ sessionId }) => browser.reload(sessionId),
    "browser.stop": ({ sessionId }) => browser.stop(sessionId),
    "browser.page": ({ sessionId }) => browser.getPage(sessionId),
    "browser.pages": ({ sessionId }) => browser.listPages(sessionId),
    "browser.page.create": ({ sessionId, url }) => browser.createPage(sessionId, url),
    "browser.page.activate": ({ sessionId, pageId }) => browser.activatePage(sessionId, pageId),
    "browser.page.close": ({ sessionId, pageId }) => browser.closePage(sessionId, pageId),
    "browser.drag": ({ sessionId, sourceRef, targetRef }) =>
      browser.drag(sessionId, sourceRef, targetRef),
    "browser.dialog.handle": ({ sessionId, accept, promptText }) =>
      browser.handleDialog(sessionId, {
        accept,
        ...(promptText === undefined ? {} : { promptText }),
      }),
    "browser.wait.text": ({ sessionId, text, options }) =>
      browser.waitForText(sessionId, text, options),
    "browser.wait.selector": ({ sessionId, selector, options }) =>
      browser.waitForSelector(sessionId, selector, options),
    "browser.wait.network-idle": ({ sessionId, options }) =>
      browser.waitForNetworkIdle(sessionId, options),
    "browser.wait.load": ({ sessionId, options }) => browser.waitForLoad(sessionId, options),
    "browser.screenshot": ({ sessionId, options }) => browser.screenshot(sessionId, options),
    "browser.files.set": ({ sessionId, ref, paths }) => browser.setFiles(sessionId, ref, paths),
    "browser.filechooser.set": ({ sessionId, chooserId, paths }) =>
      browser.setFileChooserFiles(sessionId, chooserId, paths),
    "browser.downloads": ({ sessionId }) => browser.listDownloads(sessionId),
    "browser.download.cancel": ({ sessionId, downloadId }) =>
      browser.cancelDownload(sessionId, downloadId),
    "browser.download.delete": ({ sessionId, downloadId }) =>
      browser.deleteDownload(sessionId, downloadId),
    "browser.download.save": ({ sessionId, downloadId, targetPath }) =>
      browser.saveDownload(sessionId, downloadId, targetPath),
    "browser.extensions.reload": ({ extensionPaths }) => browser.reloadExtensions(extensionPaths),
    "browser.extension.open": ({ sessionId, extensionId, page, path }) =>
      browser.openExtensionPage(sessionId, { extensionId, page, path }),
    "browser.cookies.set": ({ sessionId, cookies }) => browser.setCookies(sessionId, cookies),
    "browser.cookies.list": ({ sessionId, domain }) => browser.listCookies(sessionId, { domain }),
    "browser.cookies.clear": ({ sessionId, domain }) => browser.clearCookies(sessionId, { domain }),
    "browser.forms.detect-login": ({ sessionId, pageId }) =>
      browser.detectLoginForms(sessionId, { pageId }),
    "browser.credential.fill": ({ sessionId, pageId, username, password, origin }) =>
      browser.fillCredential(sessionId, { pageId, username, password, origin }),
    "browser.pdf": ({ sessionId, options }) => browser.pdf(sessionId, options ?? {}),
    "browser.emulate": ({ sessionId, ...options }) => browser.emulate(sessionId, options),
    "browser.storage.get": ({ sessionId, area, key, pageId }) =>
      browser.storageGet(sessionId, { area, key, pageId }),
    "browser.storage.set": ({ sessionId, area, key, value, pageId }) =>
      browser.storageSet(sessionId, { area, key, value, pageId }),
    "browser.storage.clear": ({ sessionId, area, pageId }) =>
      browser.storageClear(sessionId, { area, pageId }),
    "browser.network.request": ({ sessionId, requestId }) =>
      browser.networkRequest(sessionId, requestId),
    "browser.tabs.finalize": ({ sessionId }) => browser.finalizeTabs(sessionId),
    "browser.set-zoom": ({ sessionId, zoom }) => browser.setZoom(sessionId, zoom),
    "browser.find": ({ sessionId, query, options }) => browser.find(sessionId, query, options),
    "browser.find.clear": ({ sessionId }) => browser.findClear(sessionId),
    "browser.screencast.start": async ({ sessionId, quality }) => {
      await browser.startScreencast(sessionId, (frame) => media.publish(sessionId, frame), {
        quality,
      })
      return { started: true }
    },
    "browser.screencast.ack": ({ sessionId, sequence }) =>
      browser.ackScreencastFrame(sessionId, sequence),
    "browser.input": ({ sessionId, input }) => browser.dispatchInput(sessionId, input),
    "browser.cancel": ({ sessionId }) => browser.cancelAction(sessionId),
    ...(supervisor
      ? {
          "agent.spawn": (payload) => supervisor.spawn(payload),
          "agent.send": ({ id, message }) => supervisor.send(id, message),
          "agent.kill": ({ id }) => supervisor.kill(id),
          "agent.kill-all": () => supervisor.killAll(),
          "agent.status": ({ id }) => supervisor.status(id),
          "agent.list": () => supervisor.list(),
        }
      : {}),
  }
  return async (type, payload) => {
    const operation = Object.hasOwn(operations, type) ? operations[type] : undefined
    if (!operation)
      throw Object.assign(new Error("unknown control operation"), { code: "unknown_operation" })
    const safePayload = payload ?? {}
    const shouldAudit =
      type.startsWith("browser.") && type !== "browser.input" && type !== "browser.screencast.ack"
    const startedAt = Date.now()
    try {
      const result = await operation(safePayload)
      if (shouldAudit) {
        eventJournal.publish({
          kind: "runtime.operation",
          operation: type,
          status: "ok",
          durationMs: Date.now() - startedAt,
          ...browserAuditMetadata(type, safePayload),
        })
      }
      return result
    } catch (error) {
      if (shouldAudit) {
        eventJournal.publish({
          kind: "runtime.operation",
          operation: type,
          status: "error",
          errorCode: typeof error?.code === "string" ? error.code : "runtime_error",
          durationMs: Date.now() - startedAt,
          ...browserAuditMetadata(type, safePayload),
        })
      }
      throw error
    }
  }
}

class MediaLatestStore {
  constructor() {
    this.frames = new Map()
    this.sequence = new Map()
  }

  publish(sessionId, bytes) {
    const sequence = (this.sequence.get(sessionId) ?? 0) + 1
    this.sequence.set(sessionId, sequence)
    this.frames.set(sessionId, { sequence, bytes: Buffer.from(bytes) })
  }

  latest(sessionId, after) {
    const frame = this.frames.get(sessionId)
    return frame && frame.sequence > after ? frame : null
  }
}

/**
 * `supervisor` is optional: the desktop's local-mode entrypoint (ADR-0201)
 * hosts only the browser service, and then serves no `agent.*` operations.
 */
export function createRuntimeServer({
  secret,
  browserService,
  supervisor = null,
  eventJournal = new RuntimeEventJournal(),
}) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("workspace runtime secret must be at least 32 characters")
  }
  const media = new MediaLatestStore()
  const dispatch = createDispatcher(browserService, supervisor, media, eventJournal)
  const server = http.createServer(async (request, response) => {
    if (!authorized(request, secret)) {
      json(response, 401, { code: "unauthorized" })
      return
    }
    const url = new URL(request.url, "http://runtime.invalid")
    try {
      if (request.method === "GET" && url.pathname === "/v1/health") {
        json(response, 200, {
          version: PRIVATE_PROTOCOL_VERSION,
          status: "ready",
          browser: "ready",
          supervisor: supervisor ? "ready" : "absent",
          ...(browserService.mode === "local" ? { mode: "local" } : {}),
        })
        return
      }
      if (request.method === "GET" && url.pathname === "/v1/events") {
        const after = Number(url.searchParams.get("after") ?? 0)
        json(response, 200, protocolEnvelope("events", eventJournal.after(after)))
        return
      }
      const mediaMatch = request.method === "GET" && url.pathname.match(/^\/v1\/media\/([^/]+)$/)
      if (mediaMatch) {
        const sessionId = decodeURIComponent(mediaMatch[1])
        const after = Number(url.searchParams.get("after") ?? 0)
        const frame = media.latest(sessionId, after)
        if (!frame) {
          response.writeHead(204, { "cache-control": "no-store" })
          response.end()
          return
        }
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": frame.bytes.length,
          "x-cognia-media-sequence": String(frame.sequence),
          "cache-control": "no-store",
        })
        response.end(frame.bytes)
        return
      }
      if (request.method === "POST" && url.pathname === "/v1/control") {
        const envelope = await readJson(request)
        if (envelope.version !== PRIVATE_PROTOCOL_VERSION || typeof envelope.type !== "string") {
          json(response, 400, { code: "invalid_envelope" })
          return
        }
        const result = await dispatch(envelope.type, envelope.payload)
        json(response, 200, protocolEnvelope("result", result ?? null, envelope.requestId))
        return
      }
      json(response, 404, { code: "not_found" })
    } catch (error) {
      json(response, 400, {
        code: typeof error?.code === "string" ? error.code : "runtime_error",
        message: error instanceof Error ? error.message : String(error),
      })
    }
  })

  return {
    listen(port, host) {
      return new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(port, host, () => resolve(server.address()))
      })
    },
    // Browsers first (so no Chromium outlives the runtime even if a later
    // step stalls), then agents, then the listener. Open keep-alive and
    // event-tail connections are dropped so `server.close` cannot hang.
    async close() {
      await browserService.closeAll()
      await supervisor?.killAll()
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections?.()
      })
    },
  }
}
