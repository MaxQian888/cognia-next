import assert from "node:assert/strict"
import test from "node:test"

import {
  expect as tauriExpect,
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

test("Playwright-style role locator resolves a fresh ref before acting", async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    if (url.endsWith("/snapshot")) {
      return jsonResponse({
        ok: true,
        snapshot: {
          nodes: [
            {
              ref: "g3e2",
              role: "button",
              name: "Send",
              text: "Send",
              visible: true,
              disabled: false,
            },
          ],
        },
      })
    }
    return jsonResponse({
      ok: true,
      act: { result: { action: "click" }, snapshot: { generation: 4 } },
    })
  }
  const page = new TauriPage({ endpoint, fetchImpl })
  await page.getByRole("button", { name: "Send" }).click()
  assert.equal(calls.length, 2)
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    window: "main",
    includeText: true,
    includeHidden: true,
    query: { steps: [{ kind: "role", role: "button", name: "Send", exact: false }] },
  })
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    window: "main",
    reference: "g3e2",
    action: "click",
    args: {},
  })
})

test("strict locators reject ambiguous matches and first opts into one", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/snapshot"))
      return jsonResponse({
        ok: true,
        snapshot: {
          nodes: [
            { ref: "g1e1", visible: true },
            { ref: "g1e2", visible: true },
          ],
        },
      })
    return jsonResponse({ ok: true, act: {} })
  }
  const page = new TauriPage({ endpoint, fetchImpl })
  await assert.rejects(page.locator("button").click(), /strict locator resolved to 2/)
  await page.locator("button").first().click()
})

test("role regex and hasText filter narrow semantic locators", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/snapshot")) {
      return jsonResponse({
        ok: true,
        snapshot: {
          nodes: [
            { ref: "g1e1", name: "Send now", text: "primary" },
            { ref: "g1e2", name: "Send later", text: "secondary" },
          ],
        },
      })
    }
    return jsonResponse({ ok: true, act: {} })
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
    if (url.endsWith("/snapshot")) {
      return jsonResponse({
        ok: true,
        snapshot: {
          nodes: [{ ref: "g1e1", text: "Save", visible: true, disabled: false, editable: true }],
        },
      })
    }
    if (url.endsWith("/inspect")) return jsonResponse({ ok: true, value: "<strong>Save</strong>" })
    if (url.endsWith("/windows"))
      return jsonResponse({ ok: true, windows: [{ label: "settings", title: "Settings" }] })
    return jsonResponse({ ok: true, act: { result: { action: "click" } } })
  }
  const page = new TauriPage({ endpoint, fetchImpl, defaultTimeout: 5 })
  await page.click("button")
  assert.equal(
    await page.locator("main").getByRole("button", { name: "Save", exact: true }).innerHTML(),
    "<strong>Save</strong>"
  )
  assert.deepEqual(
    calls.find((call) => call.url.endsWith("/snapshot") && call.body.query.steps.length === 2).body
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
  let snapshots = 0
  const fetchImpl = async (url) => {
    if (url.endsWith("/snapshot")) {
      snapshots += 1
      return jsonResponse({
        ok: true,
        snapshot: {
          nodes: snapshots < 2 ? [] : [{ ref: `g${snapshots}e1`, visible: true, disabled: false }],
        },
      })
    }
    return jsonResponse({ ok: true, act: { result: { action: "click" } } })
  }
  const page = new TauriPage({ endpoint, fetchImpl, defaultTimeout: 250 })
  await page.locator("button").click()
  await tauriExpect(page.locator("button")).toBeVisible({ timeout: 20 })
  assert.ok(snapshots >= 3)
})

test("capabilities and unsupported video behavior are explicit", async () => {
  const fetchImpl = async () =>
    jsonResponse({ ok: true, helper: { capabilities: { video: false, cdp: false } } })
  const page = new TauriPage({ endpoint, fetchImpl })
  assert.deepEqual(await page.capabilities(), { video: false, cdp: false })
  assert.throws(() => page.startRecording(), TauriDebugUnsupportedError)
})
