import assert from "node:assert/strict"
import test from "node:test"

import {
  expect as tauriExpect,
  TauriDebugRendererRestartedError,
  TauriDebugTimeoutError,
  TauriDebugUnsupportedError,
  TauriPage,
} from "./agent-debug-client.mjs"

const endpoint = { baseUrl: "http://127.0.0.1:4317", devToken: "a".repeat(64) }

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

test("Playwright-style role locator performs one atomic action", async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return jsonResponse({
      ok: true,
      locator: { ok: true, value: { action: "click" } },
    })
  }
  const page = new TauriPage({ endpoint, fetchImpl })
  await page.getByRole("button", { name: "Send" }).click()
  assert.equal(calls.length, 1)
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    window: "main",
    query: { steps: [{ kind: "role", role: "button", name: "Send", exact: false }] },
    index: null,
    filters: [],
    operation: "action",
    name: "click",
    args: {},
    options: { force: false, trial: false, scroll: "auto", timeout: 10_000 },
    requirements: { visible: true, stable: true, receivesEvents: true, enabled: true },
    strict: true,
  })
})

test("strict locators reject ambiguous matches and first opts into one", async () => {
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body)
    if (body.index == null)
      return jsonResponse({
        ok: true,
        locator: {
          ok: false,
          code: "strict_mode_violation",
          error: "strict locator resolved to 2 elements",
        },
      })
    return jsonResponse({ ok: true, locator: { ok: true, value: { action: "click" } } })
  }
  const page = new TauriPage({ endpoint, fetchImpl })
  await assert.rejects(page.locator("button").click(), /strict locator resolved to 2/)
  await page.locator("button").first().click()
})

test("role regex and hasText filter narrow semantic locators", async () => {
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body)
    const nodes = body.filters.length
      ? [{ name: "Send now", text: "primary" }]
      : [{ name: "Send later", text: "secondary" }]
    return jsonResponse({ ok: true, locator: { ok: true, nodes } })
  }
  const page = new TauriPage({ endpoint, fetchImpl })
  assert.equal(await page.getByRole("button", { name: /later$/ }).count(), 1)
  assert.equal(await page.getByRole("button").filter({ hasText: "primary" }).count(), 1)
})

test("evaluate serializes a Playwright-style function argument", async () => {
  let body
  const fetchImpl = async (_url, init) => {
    body = JSON.parse(init.body)
    return jsonResponse({ ok: true, value: "Cognia" })
  }
  const page = new TauriPage({ endpoint, fetchImpl })
  assert.equal(
    await page.evaluate((selector) => document.querySelector(selector)?.textContent, "h1"),
    "Cognia"
  )
  assert.match(body.expression, /document\.querySelector/)
  assert.match(body.expression, /"h1"/)
})

test("page selector methods, nested locators, queries, and multi-window match the compatibility surface", async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: init?.body && JSON.parse(init.body) })
    if (url.endsWith("/locator")) {
      const body = JSON.parse(init.body)
      return jsonResponse({
        ok: true,
        locator: {
          ok: true,
          value: body.operation === "inspect" ? "<strong>Save</strong>" : { action: "click" },
        },
      })
    }
    if (url.endsWith("/windows"))
      return jsonResponse({ ok: true, windows: [{ label: "settings", title: "Settings" }] })
    return jsonResponse({ ok: true })
  }
  const page = new TauriPage({ endpoint, fetchImpl, defaultTimeout: 5 })
  await page.click("button")
  assert.equal(
    await page.locator("main").getByRole("button", { name: "Save", exact: true }).innerHTML(),
    "<strong>Save</strong>"
  )
  assert.deepEqual(
    calls.find((call) => call.url.endsWith("/locator") && call.body.query.steps.length === 2).body
      .query.steps,
    [
      { kind: "css", selector: "main" },
      { kind: "role", role: "button", name: "Save", exact: true },
    ]
  )
  const scoped = await page.waitForWindow((window) => window.label === "settings", { timeout: 5 })
  assert.equal(scoped.targetWindow, "settings")
})

test("auto-wait retries absent locators and assertion API polls state", async () => {
  let operations = 0
  const fetchImpl = async (_url, init) => {
    operations += 1
    const body = JSON.parse(init.body)
    if (body.operation === "action" && operations < 2)
      return jsonResponse({
        ok: true,
        locator: { ok: false, code: "not_found", error: "missing", retryable: true },
      })
    if (body.operation === "query")
      return jsonResponse({ ok: true, locator: { ok: true, nodes: [{ visible: true }] } })
    return jsonResponse({ ok: true, locator: { ok: true, value: { action: "click" } } })
  }
  const page = new TauriPage({ endpoint, fetchImpl, defaultTimeout: 250 })
  await page.locator("button").click()
  await tauriExpect(page.locator("button")).toBeVisible({ timeout: 20 })
  assert.ok(operations >= 3)
})

test("capabilities and unsupported video behavior are explicit", async () => {
  const fetchImpl = async () =>
    jsonResponse({ ok: true, helper: { capabilities: { video: false, cdp: false } } })
  const page = new TauriPage({ endpoint, fetchImpl })
  assert.deepEqual(await page.capabilities(), { video: false, cdp: false })
  assert.throws(() => page.startRecording(), TauriDebugUnsupportedError)
})

test("indexed locators apply their index to collection and state methods", async () => {
  const fetchImpl = async () =>
    jsonResponse({
      ok: true,
      locator: {
        ok: true,
        nodes: [
          { text: "first", visible: true },
          { text: "second", visible: false },
        ],
      },
    })
  const page = new TauriPage({ endpoint, fetchImpl, defaultTimeout: 0 })
  const second = page.locator("p").nth(1)

  assert.deepEqual(await second.allTextContents(), ["second"])
  assert.equal(await second.isVisible(), false)
  assert.equal(await second.count(), 1)
})

test("concurrent locator inspections use the atomic locator route", async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    if (!url.endsWith("/locator")) {
      return jsonResponse({ ok: false, error: "non-atomic locator request" }, 422)
    }
    const body = JSON.parse(init.body)
    return jsonResponse({
      ok: true,
      locator: { ok: true, value: body.query.steps[0].selector },
    })
  }
  const page = new TauriPage({ endpoint, fetchImpl, defaultTimeout: 50 })

  const values = await Promise.all([
    page.locator("#first").textContent(),
    page.locator("#second").textContent(),
  ])

  assert.deepEqual(values, ["#first", "#second"])
  assert.equal(
    calls.every((call) => call.url.endsWith("/locator")),
    true
  )
})

test("serializes and/or and relative locator filters", async () => {
  let body
  const fetchImpl = async (_url, init) => {
    body = JSON.parse(init.body)
    return jsonResponse({ ok: true, locator: { ok: true, nodes: [{ text: "Save ready" }] } })
  }
  const page = new TauriPage({ endpoint, fetchImpl })
  const save = page
    .getByRole("button")
    .and(page.getByTitle("Save"))
    .filter({ has: page.getByText("ready"), visible: true })

  assert.equal(await save.count(), 1)
  assert.equal(body.query.kind, "and")
  assert.deepEqual(body.filters, [
    { kind: "has", query: { steps: [{ kind: "text", text: "ready", exact: false }] } },
    { kind: "visible", value: true },
  ])
  assert.equal(save.or(page.getByRole("link")).query.kind, "or")
})

test("locator waitForFunction retries and ariaSnapshot uses the atomic inspect seam", async () => {
  let evaluations = 0
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body)
    if (body.name === "evaluate") {
      evaluations += 1
      return jsonResponse({ ok: true, locator: { ok: true, value: evaluations > 1 } })
    }
    return jsonResponse({ ok: true, locator: { ok: true, value: '- button "Save"' } })
  }
  const page = new TauriPage({ endpoint, fetchImpl, defaultTimeout: 100 })
  const locator = page.getByRole("button", { name: "Save" })

  await locator.waitForFunction((element) => element.textContent === "Save", undefined, {
    polling: 1,
  })
  assert.equal(await locator.ariaSnapshot({ mode: "ai" }), '- button "Save"')
  assert.equal(evaluations, 2)
})

test("diagnostic compatibility reads advance per page without draining other consumers", async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    const after = Number(new URL(url).searchParams.get("after") || 0)
    return jsonResponse({
      ok: true,
      console: {
        entries: after < 1 ? [{ id: 1, level: "warn" }] : [],
        nextCursor: 1,
        dropped: 0,
      },
    })
  }
  const page = new TauriPage({ endpoint, fetchImpl })

  assert.deepEqual(await page.consoleMessages(), [{ id: 1, level: "warn" }])
  assert.deepEqual(await page.consoleMessages(), [])
  assert.deepEqual((await page.readConsole({ after: 0 })).entries, [{ id: 1, level: "warn" }])
  assert.match(calls[1], /after=1/)
})

test("reload waits for a new document identity even when the old document is complete", async () => {
  let healthReads = 0
  const fetchImpl = async (url) => {
    if (url.endsWith("/reload")) return jsonResponse({ ok: true })
    if (url.endsWith("/evaluate")) {
      healthReads += 1
      return jsonResponse({
        ok: true,
        value: {
          documentId: healthReads < 3 ? "old-document" : "new-document",
          url: "https://app.test/",
          readyState: "complete",
          pendingRequests: 0,
        },
      })
    }
    throw new Error(`unexpected route: ${url}`)
  }
  const page = new TauriPage({ endpoint, fetchImpl, defaultTimeout: 100 })

  await page.reload()

  assert.equal(healthReads, 3)
})

test("locator retries end in a typed timeout and an AbortSignal cancels transport", async () => {
  let receivedSignal
  const fetchImpl = async (_url, init) => {
    receivedSignal = init.signal
    return jsonResponse({
      ok: true,
      locator: { ok: false, code: "not_found", error: "missing", retryable: true },
    })
  }
  const page = new TauriPage({ endpoint, fetchImpl, defaultTimeout: 0 })
  await assert.rejects(page.locator("button").click(), TauriDebugTimeoutError)

  const controller = new AbortController()
  controller.abort(new Error("cancelled by test"))
  await assert.rejects(page.locator("button").click({ signal: controller.signal }), /cancelled/)
  assert.ok(receivedSignal instanceof AbortSignal)
})

test("action-triggered SPA navigation settles against document identity and URL", async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push(url)
    if (url.endsWith("/locator"))
      return jsonResponse({
        ok: true,
        locator: {
          ok: true,
          value: true,
          navigation: true,
          previousDocumentId: "document-1",
          previousUrl: "https://app.test/before",
        },
      })
    if (url.endsWith("/evaluate"))
      return jsonResponse({
        ok: true,
        value: {
          documentId: "document-1",
          url: "https://app.test/after",
          readyState: "complete",
          pendingRequests: 0,
        },
      })
    throw new Error(`unexpected route: ${url}; ${init?.body || ""}`)
  }
  const page = new TauriPage({ endpoint, fetchImpl, defaultTimeout: 100 })

  await page.locator("a").click()

  assert.deepEqual(
    calls.map((url) => new URL(url).pathname),
    ["/api/dev/agent/locator", "/api/dev/agent/evaluate"]
  )
})

// ---------------------------------------------------------------------------
// Renderer (web content process) restarts
// ---------------------------------------------------------------------------

function health(renderers = {}) {
  return jsonResponse({ ok: true, agentDebug: true, helper: null, renderers })
}

const evalTimeout = () =>
  jsonResponse(
    { ok: false, code: "webview_eval_timeout", error: "webview async evaluation timed out" },
    422
  )

test("a bridge-reported renderer restart surfaces as a typed, retryable error", async () => {
  const fetchImpl = async () =>
    jsonResponse(
      {
        ok: false,
        code: "webview_renderer_restarted",
        error: "webview renderer restarted: the main web content process terminated",
        window: "main",
        rendererGeneration: 2,
        retryable: true,
      },
      503
    )
  const page = new TauriPage({ endpoint, fetchImpl })

  await assert.rejects(page.evaluate("1 + 1"), (error) => {
    assert.ok(error instanceof TauriDebugRendererRestartedError)
    assert.equal(error.code, "webview_renderer_restarted")
    assert.equal(error.window, "main")
    assert.equal(error.rendererGeneration, 2)
    assert.equal(error.retryable, true)
    assert.match(error.message, /renderer restarted/)
    assert.equal(error.cause.status, 503)
    return true
  })
})

test("a restarting renderer keeps its own code", async () => {
  const fetchImpl = async () =>
    jsonResponse(
      {
        ok: false,
        code: "webview_renderer_restarting",
        error: "webview renderer is restarting",
        window: "main",
        rendererGeneration: 1,
        retryable: true,
      },
      503
    )
  const page = new TauriPage({ endpoint, fetchImpl })
  await assert.rejects(page.snapshot(), (error) => {
    assert.ok(error instanceof TauriDebugRendererRestartedError)
    assert.equal(error.code, "webview_renderer_restarting")
    return true
  })
})

test("an evaluation timeout during a renderer reload reports the restart, not the timeout", async () => {
  const routes = []
  const fetchImpl = async (url) => {
    routes.push(new URL(url).pathname)
    if (url.endsWith("/evaluate")) return evalTimeout()
    if (url.endsWith("/health")) return health({ main: { generation: 1, awaitingLoad: true } })
    throw new Error(`unexpected route: ${url}`)
  }
  const page = new TauriPage({ endpoint, fetchImpl })

  await assert.rejects(page.evaluate("document.title"), (error) => {
    assert.ok(error instanceof TauriDebugRendererRestartedError)
    assert.equal(error.code, "webview_renderer_restarting")
    assert.equal(error.rendererGeneration, 1)
    assert.equal(error.cause.code, "webview_eval_timeout")
    return true
  })
  assert.deepEqual(routes, ["/api/dev/agent/evaluate", "/api/dev/agent/health"])
})

test("an evaluation timeout after the renderer generation moved reports the restart", async () => {
  let generation = 0
  const fetchImpl = async (url) => {
    if (url.endsWith("/health")) return health({ main: { generation, awaitingLoad: false } })
    if (url.endsWith("/evaluate")) return evalTimeout()
    throw new Error(`unexpected route: ${url}`)
  }
  const page = new TauriPage({ endpoint, fetchImpl })
  assert.deepEqual(await page.rendererState(), { generation: 0, awaitingLoad: false })

  // The renderer was killed and already reloaded by the time we look.
  generation = 1
  await assert.rejects(page.evaluate("1"), (error) => {
    assert.ok(error instanceof TauriDebugRendererRestartedError)
    assert.equal(error.code, "webview_renderer_restarted")
    assert.equal(error.rendererGeneration, 1)
    return true
  })
})

test("a plain evaluation timeout on a live renderer stays a timeout", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/health")) return health({})
    if (url.endsWith("/evaluate")) return evalTimeout()
    throw new Error(`unexpected route: ${url}`)
  }
  const page = new TauriPage({ endpoint, fetchImpl })
  await assert.rejects(page.evaluate("1"), (error) => {
    assert.ok(!(error instanceof TauriDebugRendererRestartedError))
    assert.equal(error.code, "webview_eval_timeout")
    return true
  })
})

test("a failing health probe keeps the original timeout error", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/health")) throw new TypeError("fetch failed")
    return evalTimeout()
  }
  const page = new TauriPage({ endpoint, fetchImpl })
  await assert.rejects(page.evaluate("1"), (error) => {
    assert.equal(error.code, "webview_eval_timeout")
    return true
  })
})

test("rebind path: after a restart, waitForRenderer waits for the reload and evaluate works again", async () => {
  let phase = "dead"
  let healthReads = 0
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/health")) {
      healthReads += 1
      if (healthReads >= 2) phase = "reloaded"
      return health({ main: { generation: 1, awaitingLoad: phase !== "reloaded" } })
    }
    if (url.endsWith("/evaluate")) {
      if (phase === "dead")
        return jsonResponse(
          {
            ok: false,
            code: "webview_renderer_restarted",
            error: "webview renderer restarted",
            window: "main",
            rendererGeneration: 1,
            retryable: true,
          },
          503
        )
      const { expression } = JSON.parse(init.body)
      if (expression.includes("health"))
        return jsonResponse({
          ok: true,
          value: { documentId: "new", readyState: "complete", url: "https://app.test/" },
        })
      return jsonResponse({ ok: true, value: 2 })
    }
    throw new Error(`unexpected route: ${url}`)
  }
  const page = new TauriPage({ endpoint, fetchImpl, defaultTimeout: 2_000 })

  await assert.rejects(page.evaluate("1 + 1"), TauriDebugRendererRestartedError)
  assert.deepEqual(await page.waitForRenderer(), { generation: 1, awaitingLoad: false })
  assert.equal(await page.evaluate("1 + 1"), 2)
})

test("waitForRenderer gives up with a typed timeout while the renderer never reloads", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/health")) return health({ main: { generation: 3, awaitingLoad: true } })
    throw new Error(`unexpected route: ${url}`)
  }
  const page = new TauriPage({ endpoint, fetchImpl })
  await assert.rejects(page.waitForRenderer({ timeout: 150 }), TauriDebugTimeoutError)
})
