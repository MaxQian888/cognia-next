import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { RemoteChromiumService } from "./browser-service.mjs"
import { WorkspaceFileBridge } from "./file-bridge.mjs"

/**
 * The submission guard (ADR-0239 phase 2b) against real Chromium: the
 * scenarios the WP10 spike measured (docs/research/2026-10-25-browser-submit-signal.md),
 * driven through the service's own agent actions. Skipped without a
 * Playwright Chromium, like the other real-browser tests.
 */

/** A text frame a WebSocket client sent (client frames are masked). */
function readClientText(buffer) {
  const length = buffer[1] & 0x7f
  const offset = length === 126 ? 4 : length === 127 ? 10 : 2
  const size = length === 126 ? buffer.readUInt16BE(2) : length === 127 ? 0 : length
  const mask = buffer.subarray(offset, offset + 4)
  const payload = buffer.subarray(offset + 4, offset + 4 + size)
  return Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4])).toString("utf8")
}

/** Two origins (127.0.0.1 and localhost) and a WebSocket endpoint; the log is what arrived. */
async function fixtureServers(t, pages) {
  const log = []
  const handler = (origin) => (request, response) => {
    let body = ""
    request.on("data", (chunk) => (body += chunk))
    request.on("end", () => {
      const url = new URL(request.url, "http://x")
      if (url.pathname === "/page") {
        response.writeHead(200, { "content-type": "text/html" })
        response.end(
          `<!doctype html><html><head><title>${url.searchParams.get("p")}</title></head><body>${pages[url.searchParams.get("p")](servers)}</body></html>`
        )
        return
      }
      if (url.pathname === "/favicon.ico") {
        response.writeHead(404)
        response.end()
        return
      }
      log.push({ at: Date.now(), origin, method: request.method, path: url.pathname, body })
      response.writeHead(200, {
        "content-type": "text/html",
        "access-control-allow-origin": "*",
      })
      response.end("<!doctype html><title>done</title>done")
    })
  }
  const a = http.createServer(handler("A"))
  const b = http.createServer(handler("B"))
  a.on("upgrade", (request, socket) => {
    const accept = crypto
      .createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64")
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
    )
    socket.on("data", (data) => {
      if ((data[0] & 0x0f) === 0x1) {
        log.push({
          at: Date.now(),
          origin: "A",
          method: "WS",
          path: "/ws",
          body: readClientText(data),
        })
      }
    })
    socket.on("error", () => undefined)
  })
  await new Promise((resolve) => a.listen(0, "127.0.0.1", resolve))
  await new Promise((resolve) => b.listen(0, "localhost", resolve))
  const servers = {
    log,
    a: `http://127.0.0.1:${a.address().port}`,
    b: `http://localhost:${b.address().port}`,
    ws: `ws://127.0.0.1:${a.address().port}/ws`,
  }
  t.after(() => {
    a.closeAllConnections?.()
    b.closeAllConnections?.()
    a.close()
    b.close()
  })
  return servers
}

const PAGES = {
  form: () =>
    `<form method="post" action="/submit"><input name="q" value="hello"><button>Send</button></form>`,
  search: () =>
    `<form method="get" action="/search"><input name="q" value="x"><button>Search</button></form>`,
  fetch: (s) =>
    `<button type="button" onclick="fetch('/api',{method:'POST',body:'x'}).then(()=>document.title='sent',()=>document.title='failed')">Save</button>` +
    `<button type="button" onclick="fetch('${s.b}/api',{method:'POST',body:'x'})">Elsewhere</button>`,
  delayed: () =>
    `<form id="f" method="post" action="/submit"><input name="q" value="x"></form><button type="button" onclick="setTimeout(function(){document.getElementById('f').submit()},1200)">Later</button>`,
  worker: (s) =>
    `<button type="button" id="t">Work</button><script>var w=new Worker(URL.createObjectURL(new Blob(["onmessage=function(){fetch('${s.a}/api',{method:'POST',body:'w'})}"],{type:'text/javascript'})));document.getElementById('t').onclick=function(){w.postMessage(1)}</script>`,
  socket: (s) =>
    `<button type="button" id="t">Chat</button><script>var ws=new WebSocket('${s.ws}');ws.onopen=function(){document.title='open'};ws.onclose=function(){document.title='closed'};document.getElementById('t').onclick=function(){ws.send('hello')}</script>`,
}

async function realChromium(t) {
  const { chromium } = await import("playwright-core")
  const executablePath =
    process.env.COGNIA_TEST_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath()
  try {
    await fs.access(executablePath)
  } catch (error) {
    if (process.env.COGNIA_TEST_CHROMIUM_EXECUTABLE_PATH) throw error
    t.skip("Playwright Chromium is not installed")
    return null
  }
  return {
    launch: (options) => chromium.launch({ ...options, executablePath }),
    launchPersistentContext: (profile, options) =>
      chromium.launchPersistentContext(profile, { ...options, executablePath }),
  }
}

async function localService(t) {
  const chromium = await realChromium(t)
  if (!chromium) return null
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cognia-submissions-"))
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }))
  const overlayScript = await fs.readFile(
    new URL("../../../lib/browser/overlay.injected.js", import.meta.url),
    "utf8"
  )
  let id = 0
  const service = new RemoteChromiumService({
    chromium,
    mode: "local",
    overlayScript,
    workspaceRoot,
    profilesRoot: path.join(workspaceRoot, ".profiles"),
    createId: () => `id-${++id}`,
    fileBridge: new WorkspaceFileBridge({ workspaceRoot }),
  })
  t.after(() => service.closeAll())
  await service.createSession({ id: "s", headless: true })
  return service
}

async function open(service, url) {
  await service.navigate("s", url)
  const page = service.activeRecord(service.sessions.get("s")).page
  await page.waitForFunction(() => typeof window.__cogniaSnapshot === "function")
  return page
}

async function refFor(service, name) {
  const snapshot = await service.snapshot("s")
  const node = snapshot.nodes.find((candidate) => candidate.name === name)
  assert(node, `no element named ${name}`)
  return node.ref
}

const arrivals = (servers, pathname) => servers.log.filter((entry) => entry.path === pathname)

test("hold: a form post waits for the host, then goes out once allowed", async (t) => {
  const service = await localService(t)
  if (!service) return
  const servers = await fixtureServers(t, PAGES)
  await service.configureSubmissionGuard("s", "hold")
  const page = await open(service, `${servers.a}/page?p=form`)
  // The host drains while the action runs: a held navigation keeps it waiting.
  const acting = service.act("s", await refFor(service, "Send"), "click", {})
  const { reports, windowOpen } = await service.drainSubmissions("s", { waitMs: 1000 })
  assert.equal(windowOpen, true)
  assert.equal(reports.length, 1)
  assert.deepEqual(
    {
      url: reports[0].url,
      method: reports[0].method,
      navigation: reports[0].navigation,
      held: reports[0].held,
    },
    { url: `${servers.a}/submit`, method: "POST", navigation: true, held: true }
  )
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(arrivals(servers, "/submit").length, 0, "held: nothing reached the site yet")

  let returned = false
  void acting.then(() => (returned = true))
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(returned, false, "the action waits for the answer")

  service.resolveSubmission("s", reports[0].id, "allow")
  const result = await acting
  assert.deepEqual({ ok: result.ok, error: result.error }, { ok: true, error: null })
  assert.equal(page.url(), `${servers.a}/submit`, "the action returns on the new document")
  assert.equal(arrivals(servers, "/submit").length, 1)
  assert.equal(arrivals(servers, "/submit")[0].body, "q=hello")
})

test("hold: a refused navigation leaves the page where it was", async (t) => {
  const service = await localService(t)
  if (!service) return
  const servers = await fixtureServers(t, PAGES)
  await service.configureSubmissionGuard("s", "hold")
  const page = await open(service, `${servers.a}/page?p=form`)
  const acting = service.act("s", await refFor(service, "Send"), "click", {})
  const { reports } = await service.drainSubmissions("s", { waitMs: 1000 })
  service.resolveSubmission("s", reports[0].id, "refuse")
  assert.equal((await acting).ok, true, "the click itself happened")
  assert.equal(page.url(), `${servers.a}/page?p=form`)
  assert.equal(await page.title(), "form")
  assert.equal(arrivals(servers, "/submit").length, 0)
})

test("hold: a refused fetch fails in the page; a cross-origin one names its site", async (t) => {
  const service = await localService(t)
  if (!service) return
  const servers = await fixtureServers(t, PAGES)
  await service.configureSubmissionGuard("s", "hold")
  const page = await open(service, `${servers.a}/page?p=fetch`)
  let acting = service.act("s", await refFor(service, "Save"), "click", {})
  let { reports } = await service.drainSubmissions("s", { waitMs: 1000 })
  assert.deepEqual(
    reports.map(({ url, resourceType, navigation }) => ({ url, resourceType, navigation })),
    [{ url: `${servers.a}/api`, resourceType: "fetch", navigation: false }]
  )
  service.resolveSubmission("s", reports[0].id, "refuse")
  await acting
  await page.waitForFunction(() => document.title === "failed")
  assert.equal(arrivals(servers, "/api").length, 0)

  acting = service.act("s", await refFor(service, "Elsewhere"), "click", {})
  ;({ reports } = await service.drainSubmissions("s", { waitMs: 1000 }))
  assert.equal(reports[0].url, `${servers.b}/api`)
  service.resolveSubmission("s", reports[0].id, "allow")
  await acting
  await page.waitForFunction(
    (count) => count > 0,
    await (async () => {
      for (let i = 0; i < 40 && arrivals(servers, "/api").length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      return arrivals(servers, "/api").length
    })()
  )
  assert.equal(arrivals(servers, "/api")[0].origin, "B")
})

test("passive requests and traffic outside an action's window pass untouched", async (t) => {
  const service = await localService(t)
  if (!service) return
  const servers = await fixtureServers(t, PAGES)
  await service.configureSubmissionGuard("s", "hold")
  const page = await open(service, `${servers.a}/page?p=search`)
  await service.act("s", await refFor(service, "Search"), "click", {})
  await page.waitForURL(/\/search\?q=x$/)
  assert.deepEqual((await service.drainSubmissions("s")).reports, [], "GET is not held")

  await open(service, `${servers.a}/page?p=fetch`)
  await new Promise((resolve) => setTimeout(resolve, 3100))
  // The page posting on its own, after every window closed, is not the agent's.
  await page.evaluate(() => fetch("/api", { method: "POST", body: "background" }))
  assert.equal(arrivals(servers, "/api").length, 1)
  assert.deepEqual((await service.drainSubmissions("s")).reports, [])
})

test("hold: a submission a moment after the click and a worker's post are caught", async (t) => {
  const service = await localService(t)
  if (!service) return
  const servers = await fixtureServers(t, PAGES)
  await service.configureSubmissionGuard("s", "hold")
  await open(service, `${servers.a}/page?p=delayed`)
  // The click returns before the page submits; the host keeps draining
  // through the grace period, as its background drain does.
  await service.act("s", await refFor(service, "Later"), "click", {})
  let { reports } = await service.drainSubmissions("s", { waitMs: 2500 })
  assert.equal(reports.length, 1, "the delayed form.submit() falls in the grace period")
  assert.equal(reports[0].navigation, true)
  service.resolveSubmission("s", reports[0].id, "refuse")

  await open(service, `${servers.a}/page?p=worker`)
  const acting = service.act("s", await refFor(service, "Work"), "click", {})
  ;({ reports } = await service.drainSubmissions("s", { waitMs: 2000 }))
  assert.equal(reports.length, 1)
  assert.equal(reports[0].url, `${servers.a}/api`)
  service.resolveSubmission("s", reports[0].id, "allow")
  await acting
  for (let i = 0; i < 40 && arrivals(servers, "/api").length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(arrivals(servers, "/api")[0].body, "w")
})

test("observe reports a submission and sends it at once", async (t) => {
  const service = await localService(t)
  if (!service) return
  const servers = await fixtureServers(t, PAGES)
  await service.configureSubmissionGuard("s", "observe")
  const page = await open(service, `${servers.a}/page?p=form`)
  await service.act("s", await refFor(service, "Send"), "click", {})
  await page.waitForURL(`${servers.a}/submit`)
  const { reports } = await service.drainSubmissions("s", { waitMs: 500 })
  assert.equal(reports.length, 1)
  assert.equal(reports[0].held, false)
  assert.equal(arrivals(servers, "/submit").length, 1)
})

test("off, the default, reports nothing", async (t) => {
  const service = await localService(t)
  if (!service) return
  const servers = await fixtureServers(t, PAGES)
  const page = await open(service, `${servers.a}/page?p=form`)
  await service.act("s", await refFor(service, "Send"), "click", {})
  await page.waitForURL(`${servers.a}/submit`)
  assert.deepEqual((await service.drainSubmissions("s", { waitMs: 300 })).reports, [])
})

test("WebSocket frames: held and relayed under hold, observed under observe", async (t) => {
  const service = await localService(t)
  if (!service) return
  const servers = await fixtureServers(t, PAGES)
  await service.configureSubmissionGuard("s", "hold")
  let page = await open(service, `${servers.a}/page?p=socket`)
  await page.waitForFunction(() => document.title === "open")
  let acting = service.act("s", await refFor(service, "Chat"), "click", {})
  let { reports } = await service.drainSubmissions("s", { waitMs: 1000 })
  assert.deepEqual(
    reports.map(({ url, method, resourceType, held }) => ({ url, method, resourceType, held })),
    [{ url: servers.ws, method: "WS", resourceType: "websocket", held: true }]
  )
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(arrivals(servers, "/ws").length, 0)
  service.resolveSubmission("s", reports[0].id, "allow")
  await acting
  for (let i = 0; i < 40 && arrivals(servers, "/ws").length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(arrivals(servers, "/ws")[0].body, "hello")

  // A refused frame closes the socket rather than vanishing.
  acting = service.act("s", await refFor(service, "Chat"), "click", {})
  ;({ reports } = await service.drainSubmissions("s", { waitMs: 1000 }))
  service.resolveSubmission("s", reports[0].id, "refuse")
  await acting
  await page.waitForFunction(() => document.title === "closed")
  assert.equal(arrivals(servers, "/ws").length, 1)

  const observing = await localService(t)
  const observed = await fixtureServers(t, PAGES)
  await observing.configureSubmissionGuard("s", "observe")
  page = await open(observing, `${observed.a}/page?p=socket`)
  await page.waitForFunction(() => document.title === "open")
  await observing.act("s", await refFor(observing, "Chat"), "click", {})
  ;({ reports } = await observing.drainSubmissions("s", { waitMs: 1000 }))
  assert.equal(reports.length, 1)
  assert.equal(reports[0].held, false)
  for (let i = 0; i < 40 && arrivals(observed, "/ws").length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(arrivals(observed, "/ws").length, 1)
})

test("closing the session refuses what it held", async (t) => {
  const service = await localService(t)
  if (!service) return
  const servers = await fixtureServers(t, PAGES)
  await service.configureSubmissionGuard("s", "hold")
  await open(service, `${servers.a}/page?p=fetch`)
  const acting = service.act("s", await refFor(service, "Save"), "click", {})
  const { reports } = await service.drainSubmissions("s", { waitMs: 1000 })
  assert.equal(reports.length, 1)
  await service.closeSession("s")
  await acting.catch(() => undefined)
  assert.equal(arrivals(servers, "/api").length, 0)
})
