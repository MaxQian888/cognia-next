// ADR-0239 WP10 spike: what can see, and hold, a submission made by an
// agent's action. Run: node docs/research/2026-10-25-browser-submit-signal/run-playwright.mjs [chromium|webkit]
//
// For every scenario in fixtures.mjs it measures, on a fresh context:
//   truth     what reached the server (no interception)
//   classify  a pre-action guess from the target element and the action
//   route     what context.route / routeWebSocket saw, holding every non-GET 300 ms
//   inject    what an interceptor script saw: installed before the page's
//             scripts in every frame (inject-early) or the top frame only
//             (inject-early-main, as Tauri's initialization_script), after
//             load (inject-late), and holding each send 300 ms (inject-hold)
// and then the bypass pages against those timings
// (ONLY_BYPASS_MAIN=1 runs the bypasses against inject-early-main alone).

import { A, BYPASSES, SCENARIOS, repoRequire, startServers } from "./fixtures.mjs"

const pw = repoRequire("playwright")
const engine = process.argv[2] ?? "chromium"
const browserType = pw[engine]
const SETTLE_MS = 2600
const HOLD_MS = 300
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The interceptor reports through a binding (it survives the navigation a
// submission causes). `mainOnly` mimics Tauri's `initialization_script`
// (top frame only); `hold` defers every send 300 ms to show it can wait.
function interceptor({ mainOnly = false, hold = false } = {}) {
  return `(() => {
  if (window.__icInstalled) return
  if (${mainOnly} && window !== window.top) return
  window.__icInstalled = true
  const HOLD = ${hold}
  const report = (kind, detail) => { try { window.__icReport && window.__icReport(kind + " " + detail) } catch (e) {} }
  const later = (f) => setTimeout(f, 300)
  const P = HTMLFormElement.prototype
  const origSubmit = P.submit
  const origRequest = P.requestSubmit
  window.addEventListener("submit", (e) => {
    const form = e.target
    if (form.__icReleased) return
    report("submit-event", form.getAttribute("action"))
    if (HOLD) { e.preventDefault(); const by = e.submitter; later(() => { form.__icReleased = true; origRequest.call(form, by || undefined) }) }
  }, true)
  P.submit = function () {
    report("form.submit", this.getAttribute("action"))
    if (HOLD) { const f = this; later(() => origSubmit.call(f)); return }
    return origSubmit.call(this)
  }
  P.requestSubmit = function () { report("form.requestSubmit", this.getAttribute("action")); return origRequest.apply(this, arguments) }
  const of = window.fetch
  window.fetch = function (input, init) {
    report("fetch", ((init && init.method) || (input && input.method) || "GET") + " " + (input && input.url ? input.url : input))
    const self = this, args = arguments
    return HOLD ? new Promise((r) => later(r)).then(() => of.apply(self, args)) : of.apply(this, arguments)
  }
  const xo = XMLHttpRequest.prototype.open
  const xs = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.open = function (m, u) { this.__ic = m + " " + u; return xo.apply(this, arguments) }
  XMLHttpRequest.prototype.send = function () {
    report("xhr", this.__ic)
    if (HOLD) { const x = this, a = arguments; later(() => xs.apply(x, a)); return }
    return xs.apply(this, arguments)
  }
  const sb = navigator.sendBeacon.bind(navigator)
  navigator.sendBeacon = function (u, d) { report("beacon", u); if (HOLD) { later(() => sb(u, d)); return true } return sb(u, d) }
  const wsSend = WebSocket.prototype.send
  WebSocket.prototype.send = function (d) { report("ws.send", this.url); if (HOLD) { const w = this; later(() => wsSend.call(w, d)); return } return wsSend.call(this, d) }
  if (window.navigation) {
    let released = false
    navigation.addEventListener("navigate", (e) => {
      report("navigate", e.navigationType + (e.formData ? " form" : "") + (e.cancelable ? " cancelable" : " not-cancelable") + (e.hashChange ? " hash" : "") + " " + e.destination.url.replace(/^https?:\\/\\/[^/]+/, ""))
      if (HOLD && !released && e.cancelable && !e.hashChange && !e.formData && e.navigationType === "push") {
        e.preventDefault(); const to = e.destination.url; later(() => { released = true; location.href = to })
      }
    })
  } else report("no-navigation-api", "")
})()`
}

const CLASSIFY = (el, action) => {
  const kind = action.kind
  if (kind === "select" || kind === "fill") return { submit: false, reason: "value change" }
  if (kind === "press" || kind === "synthetic-key") {
    if (!/Enter/.test(action.key)) return { submit: false, reason: "not Enter" }
    if (el.isContentEditable) return { submit: "maybe", reason: "Enter in contenteditable" }
    const form = el.form
    if (form && el.matches("input")) {
      const def = [...form.elements].find((e) =>
        e.matches("button:not([type]),button[type=submit],input[type=submit],input[type=image]")
      )
      const fields = [...form.elements].filter(
        (e) =>
          e.matches("input") &&
          !e.matches(
            "[type=hidden],[type=button],[type=submit],[type=reset],[type=image],[type=checkbox],[type=radio]"
          )
      )
      return { submit: !!def || fields.length === 1, reason: "implicit submission" }
    }
    return { submit: false, reason: "Enter outside a form" }
  }
  const c = el.closest("button,input[type=submit],input[type=image]")
  if (c) {
    if (c.matches("input")) return { submit: !!c.form, reason: "submit input" }
    const t = (c.getAttribute("type") || "submit").toLowerCase()
    return {
      submit: t === "submit" && !!c.form,
      reason: "button type " + t + (c.form ? "" : " (no form)"),
    }
  }
  return { submit: false, reason: "not a submit control" }
}

async function act(page, action) {
  switch (action.kind) {
    case "click":
      return page.click(action.target)
    case "press":
      await page.focus(action.target)
      return page.keyboard.press(action.key)
    case "synthetic-key":
      return page.$eval(
        action.target,
        (el, a) => {
          el.focus()
          for (const type of ["keydown", "keypress", "keyup"]) {
            el.dispatchEvent(
              new KeyboardEvent(type, {
                key: a.key,
                code: a.key,
                keyCode: 13,
                which: 13,
                bubbles: true,
                cancelable: true,
                metaKey: !!a.meta,
                ctrlKey: !!a.meta,
              })
            )
          }
        },
        action
      )
    case "synthetic-click":
      return page.$eval(action.target, (el) =>
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }))
      )
    case "click-frame":
      return page.frameLocator(action.frame).locator(action.target).click()
    case "select":
      return page.selectOption(action.target, action.value)
    case "fill":
      return page.fill(action.target, action.value)
  }
}

function hits(log, id, since) {
  return log
    .filter((e) => e.at >= since)
    .filter((e) => new URL(e.url, "http://x").searchParams.get("s")?.startsWith(id))
    .filter(
      (e) =>
        !new URL(e.url, "http://x").searchParams
          .get("s")
          .slice(id.length)
          .match(/^[0-9]/)
    )
    .map((e) => `${e.origin} ${e.method} ${e.url.replace(/\?.*$/, "")}`)
}

function firstArrival(log, id, since) {
  const at = log
    .filter((e) => e.at >= since && new URL(e.url, "http://x").searchParams.get("s") === id)
    .map((e) => e.at - since)
  return at.length ? Math.min(...at) : null
}

async function runScenario(browser, server, id, mode) {
  const scenario = SCENARIOS[id] ?? BYPASSES[id]
  const action = scenario.action ?? { kind: "click", target: "#t" }
  const context = await browser.newContext()
  const seen = []
  if (mode === "route" || mode === "route-abort") {
    await context.route("**/*", async (route) => {
      const r = route.request()
      const u = new URL(r.url())
      if (["/fixture", "/bypass", "/frame", "/favicon.ico"].includes(u.pathname))
        return route.continue()
      const hold = r.method() !== "GET"
      seen.push(
        `${hold ? "HELD" : "seen"} ${r.method()} ${r.resourceType()}${r.isNavigationRequest() ? " nav" : ""} ${u.pathname}`
      )
      if (hold && mode === "route-abort") return route.abort()
      if (hold) await sleep(HOLD_MS)
      return route.continue()
    })
    await context.routeWebSocket(/\/ws/, (ws) => {
      const server = ws.connectToServer()
      ws.onMessage(async (message) => {
        seen.push("HELD WS message")
        await sleep(HOLD_MS)
        server.send(message)
      })
    })
  }
  if (mode.startsWith("inject")) {
    await context.exposeBinding("__icReport", (_source, entry) => {
      seen.push(entry)
    })
  }
  if (mode === "inject-early") await context.addInitScript(interceptor())
  if (mode === "inject-early-main") await context.addInitScript(interceptor({ mainOnly: true }))
  if (mode === "inject-hold") await context.addInitScript(interceptor({ hold: true }))
  const page = await context.newPage()
  const path = SCENARIOS[id] ? "/fixture" : "/bypass"
  await page.goto(`${A}${path}?s=${id}`)
  await sleep(300)
  if (mode === "inject-late") {
    for (const frame of page.frames()) await frame.evaluate(interceptor()).catch(() => undefined)
  }
  let classified
  if (mode === "truth" && action.kind !== "click-frame") {
    classified = await page
      .$eval(action.target, CLASSIFY, action)
      .catch((e) => ({ error: String(e) }))
  }
  const since = Date.now()
  let actError
  await act(page, action).catch((e) => (actError = String(e).split("\n")[0]))
  await sleep(SETTLE_MS)
  const result = {
    id,
    mode,
    truth: hits(server.log, id, since),
    ...(mode === "inject-hold" || mode === "route"
      ? { firstArrivalMs: firstArrival(server.log, id, since) }
      : {}),
    ...(classified ? { classified } : {}),
    ...(mode.startsWith("route") ? { seen } : {}),
    ...(mode.startsWith("inject") ? { intercepted: [...new Set(seen)] } : {}),
    ...(mode === "route-abort" ? { pageUrl: page.url().replace(/^https?:\/\/[^/]+/, "") } : {}),
    ...(actError ? { actError } : {}),
  }
  await context.close()
  return result
}

const server = await startServers()
const browser = await browserType.launch()
const results = []
if (process.env.ONLY_BYPASS_MAIN) {
  for (const id of Object.keys(BYPASSES))
    results.push(await runScenario(browser, server, id, "inject-early-main"))
  const v = browser.version()
  await browser.close()
  server.close()
  console.log(JSON.stringify({ engine, version: v, results }, null, 1))
  process.exit(0)
}
for (const id of Object.keys(SCENARIOS)) {
  for (const mode of [
    "truth",
    "route",
    "inject-early",
    "inject-early-main",
    "inject-late",
    "inject-hold",
  ]) {
    results.push(await runScenario(browser, server, id, mode))
  }
}
for (const id of ["s1", "s3", "s8"])
  results.push(await runScenario(browser, server, id, "route-abort"))
for (const id of Object.keys(BYPASSES)) {
  for (const mode of ["truth", "inject-early", "inject-late", "inject-hold"]) {
    results.push(await runScenario(browser, server, id, mode))
  }
}
const version = browser.version()
await browser.close()
server.close()
console.log(JSON.stringify({ engine, version, results }, null, 1))
