import assert from "node:assert/strict"
import test from "node:test"

import {
  expect as tauriExpect,
  TauriDebugRendererRestartedError,
  TauriDebugTimeoutError,
  TauriDebugUnsupportedError,
  TauriDebugDocumentReplacedError,
  TauriDebugSessionError,
  TauriPage,
} from "./agent-debug-client.mjs"

const endpoint = { baseUrl: "http://127.0.0.1:4317", devToken: "a".repeat(64) }

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function actionPage({ fetchImpl, ...options }) {
  return new TauriPage({
    ...options,
    fetchImpl: (url, init) =>
      url.endsWith("/health")
        ? jsonResponse({
            ok: true,
            helper: {
              capabilities: {
                locatorActionControl: 1,
                locatorCompositionVersion: 2,
                dispatchEventInit: true,
              },
            },
          })
        : fetchImpl(url, init),
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
  const page = actionPage({ endpoint, fetchImpl })
  await page.getByRole("button", { name: "Send" }).click()
  assert.equal(calls.length, 1)
  const body = JSON.parse(calls[0].init.body)
  assert.match(body.requestId, /^[\da-f-]{36}$/)
  assert.ok(body.options.timeout > 0 && body.options.timeout <= 10_000)
  assert.ok(body.expiresAt > Date.now() - 10_000)
  assert.deepEqual(
    {
      ...body,
      requestId: undefined,
      expiresAt: undefined,
      options: { ...body.options, timeout: 10_000 },
    },
    {
      window: "main",
      query: { steps: [{ kind: "role", role: "button", name: "Send", exact: false }] },
      index: null,
      filters: [],
      operation: "action",
      name: "click",
      args: {},
      requestId: undefined,
      expiresAt: undefined,
      options: { force: false, trial: false, scroll: "auto", timeout: 10_000 },
      requirements: { visible: true, stable: true, receivesEvents: true, enabled: true },
      strict: true,
    }
  )
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
  const page = actionPage({ endpoint, fetchImpl })
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
  const page = actionPage({ endpoint, fetchImpl, defaultTimeout: 250 })
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
        locator: {
          ok: false,
          code: "not_found",
          error: "missing",
          retryable: true,
          dispatchState: "not-dispatched",
        },
      })
    if (body.operation === "query")
      return jsonResponse({ ok: true, locator: { ok: true, nodes: [{ visible: true }] } })
    return jsonResponse({ ok: true, locator: { ok: true, value: { action: "click" } } })
  }
  const page = actionPage({ endpoint, fetchImpl, defaultTimeout: 250 })
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
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body)
    const nodes = [
      { text: "first", visible: true },
      { text: "second", visible: false },
    ]
    const selected = body.index == null ? nodes : [nodes.at(body.index)].filter(Boolean)
    if (body.args?.collection)
      return jsonResponse({
        ok: true,
        locator: {
          ok: true,
          value:
            body.args.collection === "count" ? selected.length : selected.map((node) => node.text),
        },
      })
    return jsonResponse({ ok: true, locator: { ok: true, nodes: selected } })
  }
  const page = new TauriPage({ endpoint, fetchImpl, defaultTimeout: 0 })
  const second = page.locator("p").nth(1)

  assert.deepEqual(await second.allTextContents(), ["second"])
  assert.equal(await second.isVisible(), false)
  assert.equal(await second.count(), 1)
})

test("collection queries return complete counts and unnormalized text", async () => {
  const fullText = `  ${"x".repeat(600)}\n  original spacing  `
  const calls = []
  const page = new TauriPage({
    endpoint,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body)
      calls.push(body)
      const values = {
        count: 601,
        allTextContents: [fullText, ...Array(600).fill("other")],
        allInnerTexts: ["Rendered text", ...Array(600).fill("other")],
      }
      return jsonResponse({ ok: true, locator: { ok: true, value: values[body.args.collection] } })
    },
  })

  assert.equal(await page.locator("p").count(), 601)
  assert.equal((await page.locator("p").allTextContents())[0], fullText)
  assert.equal((await page.locator("p").allInnerTexts())[0], "Rendered text")
  assert.equal(
    calls.every((call) => call.strict === false && call.operation === "query"),
    true
  )
})

test("indexed node queries reach matches beyond the snapshot cap", async () => {
  const page = new TauriPage({
    endpoint,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body)
      assert.equal(body.index, 600)
      return jsonResponse({ ok: true, locator: { ok: true, nodes: [{ visible: true }] } })
    },
  })

  assert.equal(await page.locator("p").nth(600).isVisible(), true)
})

test("legacy capped collections and truncated node states refuse incomplete results", async () => {
  const nodes = Array.from({ length: 500 }, () => ({ text: "node", visible: false }))
  for (const locator of [
    { ok: true, nodes },
    { ok: true, nodes, count: 601, truncated: true },
  ]) {
    const page = new TauriPage({
      endpoint,
      fetchImpl: async () => jsonResponse({ ok: true, locator }),
    })

    await assert.rejects(page.locator("p").count(), TauriDebugUnsupportedError)
    await assert.rejects(page.locator("p").allTextContents(), TauriDebugUnsupportedError)
    await assert.rejects(page.locator("p").isVisible(), TauriDebugUnsupportedError)
  }
  const legacySmall = new TauriPage({
    endpoint,
    fetchImpl: async () =>
      jsonResponse({ ok: true, locator: { ok: true, nodes: nodes.slice(0, 3) } }),
  })
  assert.equal(await legacySmall.locator("p").count(), 3)
})

test("dispatchEvent refuses legacy initialization semantics before dispatch", async () => {
  const routes = []
  const page = new TauriPage({
    endpoint,
    fetchImpl: async (url) => {
      routes.push(url)
      return jsonResponse({ ok: true, helper: { capabilities: { locatorActionControl: 1 } } })
    },
  })

  await assert.rejects(
    page.locator("button").dispatchEvent("click", { button: 2 }),
    TauriDebugUnsupportedError
  )
  assert.equal(
    routes.some((url) => url.endsWith("/locator")),
    false
  )
})

test("unsupported DOM event constructors surface as a capability error without retry", async () => {
  let actions = 0
  const page = new TauriPage({
    endpoint,
    fetchImpl: async (url) => {
      if (url.endsWith("/health"))
        return jsonResponse({
          ok: true,
          helper: { capabilities: { dispatchEventInit: true, locatorActionControl: 1 } },
        })
      actions += 1
      return jsonResponse({
        ok: true,
        locator: {
          ok: false,
          code: "unsupported_event_class",
          error: "PointerEvent is unavailable",
        },
      })
    },
  })

  await assert.rejects(
    page.locator("button").dispatchEvent("pointerdown"),
    TauriDebugUnsupportedError
  )
  assert.equal(actions, 1)
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
  const page = new TauriPage({ endpoint, fetchImpl, defaultTimeout: 500 })
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

test("console and network readers carry independent document-scoped cursors through reload", async () => {
  let documentId = "before-reload"
  const calls = []
  const fetchImpl = async (url) => {
    const parsed = new URL(url)
    calls.push(parsed)
    const kind = parsed.pathname.endsWith("/console") ? "console" : "network"
    const after = Number(parsed.searchParams.get("after"))
    const cursorReset =
      parsed.searchParams.has("documentId") && parsed.searchParams.get("documentId") !== documentId
    const id = documentId === "before-reload" ? 3 : 1
    return jsonResponse({
      ok: true,
      [kind]: {
        documentId,
        cursorReset,
        entries: cursorReset || after < id ? [{ id, documentId }] : [],
        nextCursor: id,
        dropped: 0,
      },
    })
  }
  const page = new TauriPage({ endpoint, fetchImpl })
  assert.deepEqual(await page.consoleMessages(), [{ id: 3, documentId }])
  assert.deepEqual(await page.networkEvents(), [{ id: 3, documentId }])

  documentId = "after-reload"
  assert.deepEqual(await page.consoleMessages(), [{ id: 1, documentId }])
  assert.deepEqual(await page.networkEvents(), [{ id: 1, documentId }])
  assert.deepEqual(await page.consoleMessages(), [])
  assert.deepEqual(await page.networkEvents(), [])
  assert.equal(calls[2].searchParams.get("documentId"), "before-reload")
  assert.equal(calls[3].searchParams.get("documentId"), "before-reload")
  assert.equal(calls[4].searchParams.get("after"), "1")
  assert.equal(calls[5].searchParams.get("documentId"), "after-reload")
})

test("nested locators retain parent indices and filters before selecting descendants", async () => {
  const bodies = []
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/health"))
      return jsonResponse({ ok: true, helper: { capabilities: { locatorCompositionVersion: 2 } } })
    bodies.push(JSON.parse(init.body))
    return jsonResponse({ ok: true, locator: { ok: true, value: "Save" } })
  }
  const page = new TauriPage({ endpoint, fetchImpl })
  await page
    .locator("section")
    .filter({ hasText: "Account" })
    .nth(1)
    .getByRole("button")
    .textContent()
  await page.locator("section").last().getByRole("button").textContent()
  assert.deepEqual(bodies[0].query, {
    kind: "chain",
    root: {
      kind: "filtered",
      query: { steps: [{ kind: "css", selector: "section" }] },
      filters: [{ kind: "hasText", value: "Account" }],
      index: 1,
    },
    step: { kind: "role", role: "button" },
  })
  assert.equal(bodies[1].query.root.index, -1)
  assert.deepEqual(bodies[0].filters, [])
  assert.equal(bodies[0].index, null)
})

test("scoped locator queries refuse older helpers before performing an action", async () => {
  const routes = []
  const page = new TauriPage({
    endpoint,
    fetchImpl: async (url) => {
      routes.push(url)
      return jsonResponse({ ok: true, helper: { capabilities: {} } })
    },
  })
  await assert.rejects(
    page.locator("section").nth(1).getByRole("button").click(),
    TauriDebugUnsupportedError
  )
  assert.equal(
    routes.some((url) => url.endsWith("/locator")),
    false
  )
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
  const page = new TauriPage({ endpoint, fetchImpl, defaultTimeout: 500 })

  await page.reload()

  assert.equal(healthReads, 3)
})

test("locator retries end in a typed timeout and an AbortSignal cancels transport", async () => {
  let receivedSignal
  const fetchImpl = async (_url, init) => {
    receivedSignal = init.signal
    return jsonResponse({
      ok: true,
      locator: {
        ok: false,
        code: "not_found",
        error: "missing",
        retryable: true,
        dispatchState: "not-dispatched",
      },
    })
  }
  const page = actionPage({ endpoint, fetchImpl, defaultTimeout: 20 })
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
  const page = actionPage({ endpoint, fetchImpl, defaultTimeout: 500 })

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

test("a bridge-reported renderer restart leaves an unknown outcome and forbids automatic replay", async () => {
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
    assert.equal(error.retryable, false)
    assert.equal(error.dispatchState, "unknown")
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

test("a renderer restart after a click never replays the mutation", async () => {
  let actions = 0
  const page = actionPage({
    endpoint,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body)
      if (body.operation === "cancel") return jsonResponse({ ok: true })
      actions += 1
      return jsonResponse(
        {
          ok: false,
          code: "webview_renderer_restarted",
          error: "renderer restarted after dispatch",
          retryable: true,
          rendererGeneration: 1,
        },
        503
      )
    },
  })
  await assert.rejects(page.locator("button").click(), (error) => {
    assert.ok(error instanceof TauriDebugRendererRestartedError)
    assert.equal(error.dispatchState, "unknown")
    return true
  })
  assert.equal(actions, 1)
})

test("only a known failure explicitly marked before dispatch may retry an action", async () => {
  for (const result of [
    { code: "not_found", retryable: true },
    { code: "action_failed", retryable: true, dispatchState: "dispatched" },
    { code: "unexpected_failure", retryable: true, dispatchState: "not-dispatched" },
  ]) {
    let actions = 0
    const page = actionPage({
      endpoint,
      fetchImpl: async () => {
        actions += 1
        return jsonResponse({ ok: true, locator: { ok: false, error: "refuse replay", ...result } })
      },
    })
    await assert.rejects(page.locator("button").click(), /refuse replay/)
    assert.equal(actions, 1)
  }
})

test("actions refuse helpers without cancellation fences before dispatch", async () => {
  let actions = 0
  const page = new TauriPage({
    endpoint,
    fetchImpl: async (url) => {
      if (url.endsWith("/locator")) actions += 1
      return jsonResponse({ ok: true, helper: { capabilities: {} } })
    },
  })
  await assert.rejects(page.locator("button").click(), TauriDebugUnsupportedError)
  assert.equal(actions, 0)
})

test("cancelling an in-flight action sends its ID to the helper once", async () => {
  const controller = new AbortController()
  let started
  const dispatched = new Promise((resolve) => {
    started = resolve
  })
  let actionId
  const cancelledIds = []
  const page = actionPage({
    endpoint,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body)
      if (body.operation === "cancel") {
        cancelledIds.push(body.requestId)
        return jsonResponse({ ok: true })
      }
      actionId = body.requestId
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })
        started()
      })
    },
  })
  const action = page.locator("button").click({ signal: controller.signal })
  await dispatched
  controller.abort(new Error("stop pending action"))
  await assert.rejects(action, /stop pending action/)
  assert.deepEqual(cancelledIds, [actionId])
})

test("retries and navigation settling consume the same action budget", async () => {
  const budgets = []
  const page = actionPage({
    endpoint,
    defaultTimeout: 1_000,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body)
      if (url.endsWith("/locator")) {
        budgets.push(body.options.timeout)
        if (budgets.length === 1)
          return jsonResponse({
            ok: true,
            locator: {
              ok: false,
              code: "not_found",
              error: "missing",
              retryable: true,
              dispatchState: "not-dispatched",
            },
          })
        return jsonResponse({
          ok: true,
          locator: {
            ok: true,
            value: true,
            navigation: true,
            previousDocumentId: "a",
            previousUrl: "https://app.test/before",
          },
        })
      }
      budgets.push(body.timeout)
      return jsonResponse({
        ok: true,
        value: {
          documentId: "a",
          url: "https://app.test/after",
          readyState: "complete",
          pendingRequests: 0,
        },
      })
    },
  })
  await page.locator("a").click()
  assert.equal(budgets.length, 3)
  assert.ok(budgets[1] < budgets[0])
  assert.ok(budgets[2] <= budgets[1])
  assert.ok(budgets.every((value) => value > 0 && value <= 1_000))
})

test("dragTo sends the complete destination selection in the source action", async () => {
  const bodies = []
  const page = actionPage({
    endpoint,
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body))
      return jsonResponse({ ok: true, locator: { ok: true, value: true } })
    },
  })
  const target = page.locator(".target").filter({ hasText: "Drop" }).last()
  await page.locator(".source").dragTo(target)
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].operation, "action")
  assert.equal(bodies[0].name, "dragTo")
  assert.deepEqual(bodies[0].args.targetQuery, {
    kind: "filtered",
    query: { steps: [{ kind: "css", selector: ".target" }] },
    filters: [{ kind: "hasText", value: "Drop" }],
    index: -1,
  })
})

test("single-element state queries and waits reject ambiguous matches", async () => {
  const strictValues = []
  const page = new TauriPage({
    endpoint,
    fetchImpl: async (_url, init) => {
      strictValues.push(JSON.parse(init.body).strict)
      // Also exercise strictness against an older helper returning nodes.
      return jsonResponse({
        ok: true,
        locator: { ok: true, nodes: [{ visible: true }, { visible: false }] },
      })
    },
  })
  const locator = page.locator("button")
  for (const read of [
    () => locator.isVisible(),
    () => locator.isHidden(),
    ...["attached", "detached", "visible", "hidden"].map(
      (state) => () => locator.waitFor({ state })
    ),
  ])
    await assert.rejects(read(), /strict locator/)
  assert.ok(strictValues.every(Boolean))
})

test("zero-match visibility and hidden/detached waits remain valid", async () => {
  const page = new TauriPage({
    endpoint,
    fetchImpl: async () => jsonResponse({ ok: true, locator: { ok: true, nodes: [] } }),
  })
  assert.equal(await page.locator("missing").isVisible(), false)
  assert.equal(await page.locator("missing").isHidden(), true)
  await page.locator("missing").waitFor({ state: "hidden" })
  await page.locator("missing").waitFor({ state: "detached" })
})

test("an expected URL waits for navigation scheduled after action completion", async () => {
  let clicks = 0
  let urlReads = 0
  let currentUrl = "https://app.test/before"
  const page = actionPage({
    endpoint,
    defaultTimeout: 1_000,
    fetchImpl: async (url, init) => {
      if (url.endsWith("/locator")) {
        clicks += 1
        return jsonResponse({ ok: true, locator: { ok: true, value: true, navigation: false } })
      }
      const { expression } = JSON.parse(init.body)
      if (expression.includes("health"))
        return jsonResponse({
          ok: true,
          value: { documentId: "a", url: currentUrl, readyState: "complete", pendingRequests: 0 },
        })
      urlReads += 1
      if (urlReads >= 2) currentUrl = "https://app.test/after"
      // Execute the serialized matcher against this fixture's current location.
      const value = new Function("location", `return ${expression}`)({ href: currentUrl })
      return jsonResponse({ ok: true, value })
    },
  })
  await page.locator("a").click({ waitForURL: /\/after$/ })
  assert.equal(clicks, 1)
  assert.equal(urlReads, 2)
})

test("a failed navigation wait never replays its completed click", async () => {
  let clicks = 0
  const page = actionPage({
    endpoint,
    fetchImpl: async (url) => {
      if (url.endsWith("/locator")) {
        clicks += 1
        return jsonResponse({ ok: true, locator: { ok: true, value: true } })
      }
      return jsonResponse({ ok: true, value: false })
    },
  })
  await assert.rejects(
    page.locator("a").click({ timeout: 30, waitForURL: "https://app.test/missing" }),
    (error) => {
      assert.ok(error instanceof TauriDebugTimeoutError)
      assert.equal(error.dispatchState, "dispatched")
      return true
    }
  )
  assert.equal(clicks, 1)
})

test("page polling and URL waits propagate abort without another evaluation", async () => {
  const controller = new AbortController()
  const page = new TauriPage({
    endpoint,
    fetchImpl: async (_url, init) => {
      assert.ok(init.signal instanceof AbortSignal)
      controller.abort(new Error("stop URL wait"))
      return jsonResponse({ ok: true, value: false })
    },
  })
  await assert.rejects(page.waitForURL(/after/, { signal: controller.signal }), /stop URL wait/)
})

test("waitForURL string matching rejects a substring-only destination", async () => {
  let reads = 0
  const page = new TauriPage({
    endpoint,
    fetchImpl: async (_url, init) => {
      const { expression } = JSON.parse(init.body)
      if (expression.includes("health"))
        return jsonResponse({
          ok: true,
          value: { documentId: "a", readyState: "complete", pendingRequests: 0 },
        })
      reads += 1
      const location = {
        href: reads === 1 ? "https://app.test/after/extra" : "https://app.test/after",
      }
      return jsonResponse({
        ok: true,
        value: new Function("location", `return ${expression}`)(location),
      })
    },
  })
  await page.waitForURL("https://app.test/after", { timeout: 1_000 })
  assert.equal(reads, 2)
})

function managedEndpoint(instance, port, pid) {
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    devToken: `${instance}-`.padEnd(64, "a"),
    debugSession: { sessionId: "managed-run", workspace: "/repo", appInstanceId: instance, pid },
  }
}

function managedHealth(endpoint, extra = {}) {
  return jsonResponse({
    ok: true,
    agentDebug: true,
    pid: endpoint.debugSession.pid,
    debugSession: endpoint.debugSession,
    helper: {
      version: 3,
      revision: 4,
      readyState: "complete",
      documentId: endpoint.debugSession.appInstanceId,
      capabilities: { locatorActionControl: 1, documentScopedRefs: true },
    },
    renderers: {
      main: { generation: 0, awaitingLoad: false, documentEpoch: 1, documentLoading: false },
    },
    ...extra,
  })
}

test("the next command rediscovers a rebuilt app and clears old diagnostic cursors", async () => {
  const before = managedEndpoint("old", 4317, 101)
  const after = managedEndpoint("new", 4318, 202)
  let current = before
  const calls = []
  const page = new TauriPage({
    endpoint: before,
    endpointLoader: () => current,
    fetchImpl: async (url, init) => {
      calls.push({ url, token: init.headers["X-Cognia-Dev-Token"] })
      if (url.endsWith("/health")) return managedHealth(after)
      return jsonResponse({ ok: true, value: url.startsWith(before.baseUrl) ? 1 : 2 })
    },
  })
  assert.equal(await page.evaluate("1"), 1)
  page._consoleCursor = 7
  page._networkCursor = 9
  page._consoleDocumentId = page._networkDocumentId = "old-document"
  current = after
  assert.equal(await page.evaluate("2"), 2)
  assert.equal(page.endpoint.baseUrl, after.baseUrl)
  assert.equal(page._consoleCursor, 0)
  assert.equal(page._networkCursor, 0)
  assert.equal(page._consoleDocumentId, null)
  assert.equal(page._networkDocumentId, null)
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      `${before.baseUrl}/api/dev/agent/evaluate`,
      `${after.baseUrl}/api/dev/agent/health`,
      `${after.baseUrl}/api/dev/agent/evaluate`,
    ]
  )
  assert.equal(calls.at(-1).token, after.devToken)
})

test("rediscovery refuses another run or workspace before sending an operation", async () => {
  for (const changed of [{ sessionId: "other-run" }, { workspace: "/other" }]) {
    const before = managedEndpoint("old", 4317, 101)
    const after = managedEndpoint("new", 4318, 202)
    Object.assign(after.debugSession, changed)
    const calls = []
    const page = new TauriPage({
      endpoint: before,
      endpointLoader: () => after,
      fetchImpl: async (url) => {
        calls.push(url)
        return managedHealth(after)
      },
    })
    await assert.rejects(
      page.evaluate("sideEffect()"),
      (error) => error instanceof TauriDebugSessionError && error.code === "debug_session_mismatch"
    )
    assert.deepEqual(calls, [])
    assert.equal(page.endpoint, before)
  }
})

test("discovery ownership must agree with the authenticated app", async () => {
  const before = managedEndpoint("old", 4317, 101)
  const after = managedEndpoint("new", 4318, 202)
  const calls = []
  const page = new TauriPage({
    endpoint: before,
    endpointLoader: () => after,
    fetchImpl: async (url) => {
      calls.push(url)
      return managedHealth(after, {
        debugSession: { ...after.debugSession, appInstanceId: "unrelated" },
      })
    },
  })
  await assert.rejects(
    page.evaluate("sideEffect()"),
    (error) => error instanceof TauriDebugSessionError && error.code === "debug_session_mismatch"
  )
  assert.deepEqual(calls, [`${after.baseUrl}/api/dev/agent/health`])
  assert.equal(page.endpoint, before)
})

test("a restart interrupts a mutation once, and renderer recovery reconnects without replay", async () => {
  const before = managedEndpoint("old", 4317, 101)
  const after = managedEndpoint("new", 4318, 202)
  let current = before
  let actions = 0
  const cancellations = []
  const page = new TauriPage({
    endpoint: before,
    endpointLoader: () => current,
    fetchImpl: async (url, init) => {
      if (url.endsWith("/health")) return managedHealth(current)
      const body = JSON.parse(init.body)
      if (body.operation === "cancel") {
        cancellations.push(url)
        return jsonResponse({ ok: true })
      }
      if (url.endsWith("/locator")) {
        actions += 1
        current = after
        throw new TypeError("fetch failed after mutation")
      }
      return jsonResponse({
        ok: true,
        value: { readyState: "complete", documentId: "new-document" },
      })
    },
  })
  await assert.rejects(page.locator("button").click(), (error) => {
    assert.ok(error instanceof TauriDebugSessionError)
    assert.equal(error.code, "debug_connection_lost")
    assert.equal(error.dispatchState, "unknown")
    return true
  })
  assert.equal(actions, 1)
  assert.deepEqual(cancellations, [`${before.baseUrl}/api/dev/agent/locator`])
  await page.waitForRenderer()
  assert.deepEqual(page.endpoint, after)
  assert.equal(actions, 1)
})

test("reconnection waits through an unavailable app and a loading replacement page", async () => {
  const before = managedEndpoint("old", 4317, 101)
  const after = managedEndpoint("new", 4318, 202)
  let current = before
  let probes = 0
  const page = new TauriPage({
    endpoint: before,
    endpointLoader: () => current,
    fetchImpl: async () => {
      probes += 1
      if (probes === 1) {
        current = after
        throw new TypeError("fetch failed")
      }
      if (probes === 2)
        return managedHealth(after, {
          helper: null,
          renderers: {
            main: { generation: 0, awaitingLoad: false, documentEpoch: 1, documentLoading: true },
          },
        })
      return managedHealth(after)
    },
  })
  await page.reconnect({ timeout: 1_000 })
  assert.equal(probes, 3)
  assert.deepEqual(page.endpoint, after)
})

test("reconnection can be aborted while the replacement is unavailable", async () => {
  const before = managedEndpoint("old", 4317, 101)
  const controller = new AbortController()
  let started
  const probing = new Promise((resolve) => {
    started = resolve
  })
  const page = new TauriPage({
    endpoint: before,
    endpointLoader: () => before,
    fetchImpl: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })
        started()
      }),
  })
  const reconnecting = page.reconnect({ signal: controller.signal })
  await probing
  controller.abort(new Error("cancel rebuild wait"))
  await assert.rejects(reconnecting, /cancel rebuild wait/)
})

test("a reconnection deadline prevents an operation from being submitted afterwards", async () => {
  const before = managedEndpoint("old", 4317, 101)
  const after = managedEndpoint("new", 4318, 202)
  let operations = 0
  const page = new TauriPage({
    endpoint: before,
    endpointLoader: () => after,
    fetchImpl: async (url) => {
      if (!url.endsWith("/health")) operations += 1
      await new Promise((resolve) => setTimeout(resolve, 30))
      return managedHealth(after)
    },
  })
  await assert.rejects(
    page.evaluate("sideEffect()", undefined, { timeout: 10 }),
    TauriDebugTimeoutError
  )
  assert.equal(operations, 0)
})

test("an old instance response is not accepted after a concurrent reconnection", async () => {
  const before = managedEndpoint("old", 4317, 101)
  const after = managedEndpoint("new", 4318, 202)
  let current = before
  let finishOld
  let startOld
  const oldStarted = new Promise((resolve) => {
    startOld = resolve
  })
  const page = new TauriPage({
    endpoint: before,
    endpointLoader: () => current,
    fetchImpl: async (url) => {
      if (url.endsWith("/health")) return managedHealth(after)
      if (url.startsWith(before.baseUrl))
        return new Promise((resolve) => {
          finishOld = resolve
          startOld()
        })
      return jsonResponse({ ok: true, value: 2 })
    },
  })
  const pending = page.evaluate("oldSideEffect()")
  await oldStarted
  current = after
  assert.equal(await page.evaluate("newRead()"), 2)
  finishOld(jsonResponse({ ok: true, value: 1 }))
  await assert.rejects(
    pending,
    (error) => error instanceof TauriDebugSessionError && error.code === "debug_app_restarted"
  )
})

test("window-scoped clients preserve the managed endpoint loader", async () => {
  const before = managedEndpoint("old", 4317, 101)
  const after = managedEndpoint("new", 4318, 202)
  let body
  const page = new TauriPage({
    endpoint: before,
    endpointLoader: () => after,
    fetchImpl: async (url, init) => {
      if (url.endsWith("/health")) return managedHealth(after)
      body = JSON.parse(init.body)
      return jsonResponse({ ok: true, value: 42 })
    },
  })
  assert.equal(await page.window("settings").evaluate("42"), 42)
  assert.equal(body.window, "settings")
})

test("ordinary document replacement is typed and never replays a mutation", async () => {
  let actions = 0
  const page = actionPage({
    endpoint,
    fetchImpl: async (_url, init) => {
      if (JSON.parse(init.body).operation === "cancel") return jsonResponse({ ok: true })
      actions += 1
      return jsonResponse(
        {
          ok: false,
          code: "webview_document_replaced",
          window: "main",
          documentEpoch: 2,
          error: "document replaced",
          retryable: false,
        },
        409
      )
    },
  })
  await assert.rejects(page.locator("button").click(), (error) => {
    assert.ok(error instanceof TauriDebugDocumentReplacedError)
    assert.equal(error.documentEpoch, 2)
    assert.equal(error.dispatchState, "unknown")
    return true
  })
  assert.equal(actions, 1)
})

test("legacy connections cannot silently adopt a different process", async () => {
  const page = new TauriPage({ endpoint, endpointLoader: () => managedEndpoint("new", 4318, 202) })
  await assert.rejects(page.reconnect(), TauriDebugUnsupportedError)
})

test("managed discovery refuses non-loopback endpoints before sending a credential", async () => {
  const before = managedEndpoint("old", 4317, 101)
  const after = { ...managedEndpoint("new", 4318, 202), baseUrl: "https://example.com" }
  let requests = 0
  const page = new TauriPage({
    endpoint: before,
    endpointLoader: () => after,
    fetchImpl: async () => {
      requests += 1
      return managedHealth(after)
    },
  })
  await assert.rejects(
    page.evaluate("sideEffect()"),
    (error) => error instanceof TauriDebugSessionError && error.code === "debug_endpoint_invalid"
  )
  assert.equal(requests, 0)
})

test("replacement authentication failure never adopts the endpoint or submits an operation", async () => {
  const before = managedEndpoint("old", 4317, 101)
  const after = managedEndpoint("new", 4318, 202)
  const calls = []
  const page = new TauriPage({
    endpoint: before,
    endpointLoader: () => after,
    fetchImpl: async (url) => {
      calls.push(url)
      return jsonResponse({ ok: false, code: "bad_dev_token", error: "bad token" }, 401)
    },
  })
  await assert.rejects(
    page.evaluate("sideEffect()"),
    (error) =>
      error instanceof TauriDebugSessionError &&
      error.code === "debug_session_authentication_failed"
  )
  assert.equal(page.endpoint, before)
  assert.deepEqual(calls, [`${after.baseUrl}/api/dev/agent/health`])
})

test("renderer recovery waits for ordinary page loading to finish", async () => {
  let healthReads = 0
  let pageReads = 0
  const page = new TauriPage({
    endpoint,
    fetchImpl: async (url) => {
      if (url.endsWith("/health")) {
        healthReads += 1
        return jsonResponse({
          ok: true,
          renderers: {
            main: {
              generation: 0,
              awaitingLoad: false,
              documentEpoch: 2,
              documentLoading: healthReads === 1,
            },
          },
        })
      }
      pageReads += 1
      return jsonResponse({ ok: true, value: { readyState: "complete", documentId: "new" } })
    },
  })
  const renderer = await page.waitForRenderer({ timeout: 1_000 })
  assert.equal(renderer.documentEpoch, 2)
  assert.equal(renderer.documentLoading, false)
  assert.equal(healthReads, 2)
  assert.equal(pageReads, 1)
})
