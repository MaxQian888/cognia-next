import crypto from "node:crypto"
import http from "node:http"

import { PRIVATE_PROTOCOL_VERSION, protocolEnvelope } from "./protocol.mjs"

const MAX_CONTROL_BODY_BYTES = 1024 * 1024

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

export class RuntimeEventJournal {
  constructor(maxEvents = 512) {
    this.maxEvents = maxEvents
    this.sequence = 0
    this.events = []
  }

  publish(event) {
    this.sequence += 1
    this.events.push({ sequence: this.sequence, timestamp: Date.now(), ...event })
    if (this.events.length > this.maxEvents)
      this.events.splice(0, this.events.length - this.maxEvents)
  }

  after(sequence) {
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
  } else if (type === "browser.navigate" && typeof payload.url === "string") {
    try {
      metadata.navigationDomain = new URL(payload.url).hostname
    } catch {
      metadata.navigationDomain = "invalid"
    }
  } else if (type === "browser.act" && typeof payload.action === "string") {
    metadata.action = payload.action
  } else if (type === "browser.files.set") {
    metadata.fileCount = Array.isArray(payload.paths) ? payload.paths.length : 0
  }
  return metadata
}

function createDispatcher(browser, supervisor, media, eventJournal) {
  const operations = {
    "browser.session.create": (payload) => browser.createSession(payload),
    "browser.session.close": ({ sessionId }) => browser.closeSession(sessionId),
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
    "browser.downloads": ({ sessionId }) => browser.listDownloads(sessionId),
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
    "agent.spawn": (payload) => supervisor.spawn(payload),
    "agent.send": ({ id, message }) => supervisor.send(id, message),
    "agent.kill": ({ id }) => supervisor.kill(id),
    "agent.kill-all": () => supervisor.killAll(),
    "agent.status": ({ id }) => supervisor.status(id),
    "agent.list": () => supervisor.list(),
  }
  return async (type, payload) => {
    const operation = operations[type]
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

export function createRuntimeServer({
  secret,
  browserService,
  supervisor,
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
          supervisor: "ready",
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
    async close() {
      await browserService.closeAll()
      await supervisor.killAll()
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    },
  }
}
