import { describe, expect, it } from "vitest"

import { createStatusFixture } from "../../../../../lib/status/fixtures"
import type { FetchLike } from "./http"
import { runMonitoringChecks } from "./monitoring"

const PAGE = "https://status.example.test/status/"
const API = "https://status.example.test/api/status/v1"

type Routes = Record<string, () => Response | Promise<Response>>

function fakeFetch(routes: Routes): FetchLike {
  return async (url) => {
    const handler = routes[String(url)]
    if (!handler) return new Response("missing", { status: 404 })
    return handler()
  }
}

const html = () =>
  new Response("<!doctype html><html><head></head><body>status</body></html>", {
    headers: { "content-type": "text/html; charset=utf-8" },
  })
const healthz = () => Response.json({ ok: true, service: "cognia-status" })
const snapshot = () => Response.json(createStatusFixture("operational", "24h"))

async function check(routes: Routes) {
  const results = await runMonitoringChecks({
    statusPageUrl: PAGE,
    apiBase: API,
    signal: new AbortController().signal,
    fetchImpl: fakeFetch(routes),
  })
  return Object.fromEntries(results.map((result) => [result.checkId, result]))
}

const healthy: Routes = {
  [PAGE]: html,
  [`${API}/healthz`]: healthz,
  [`${API}/snapshot?range=24h`]: snapshot,
}

describe("runMonitoringChecks", () => {
  it("passes when the page is HTML and the API serves a valid live snapshot", async () => {
    const results = await check(healthy)
    expect(results.statusPage).toMatchObject({ result: "pass", reason: null, attempted: true })
    expect(results.statusApi).toMatchObject({ result: "pass", reason: null, attempted: true })
  })

  it.each<[string, Routes, string, string]>([
    [
      "page 503",
      { ...healthy, [PAGE]: () => new Response("down", { status: 503 }) },
      "statusPage",
      "http_status",
    ],
    [
      "page not HTML",
      { ...healthy, [PAGE]: () => Response.json({ hello: "world" }) },
      "statusPage",
      "schema_mismatch",
    ],
    [
      "healthz 500",
      { ...healthy, [`${API}/healthz`]: () => new Response(null, { status: 500 }) },
      "statusApi",
      "http_status",
    ],
    [
      "healthz not ok",
      { ...healthy, [`${API}/healthz`]: () => Response.json({ ok: false }) },
      "statusApi",
      "schema_mismatch",
    ],
    [
      "snapshot invalid",
      {
        ...healthy,
        [`${API}/snapshot?range=24h`]: () => Response.json({ schemaVersion: 1, mode: "preview" }),
      },
      "statusApi",
      "schema_mismatch",
    ],
    [
      "snapshot unsupported version",
      {
        ...healthy,
        [`${API}/snapshot?range=24h`]: () =>
          Response.json({ ...createStatusFixture(), schemaVersion: 2 }),
      },
      "statusApi",
      "schema_mismatch",
    ],
    [
      "snapshot too large",
      { ...healthy, [`${API}/snapshot?range=24h`]: () => new Response("x".repeat(300 * 1024)) },
      "statusApi",
      "schema_mismatch",
    ],
    [
      "network failure",
      {
        ...healthy,
        [`${API}/healthz`]: () => {
          throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } })
        },
      },
      "statusApi",
      "dns_error",
    ],
  ])("fails on %s", async (_label, routes, checkId, reason) => {
    const results = await check(routes)
    expect(results[checkId]).toMatchObject({ result: "fail", reason, attempted: true })
  })

  it("times out a hanging endpoint", async () => {
    const results = await runMonitoringChecks({
      statusPageUrl: PAGE,
      apiBase: API,
      signal: new AbortController().signal,
      timeoutMs: 100,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))
        }),
    })
    expect(results.map((result) => [result.checkId, result.result, result.reason])).toEqual([
      ["statusPage", "fail", "timeout"],
      ["statusApi", "fail", "timeout"],
    ])
  })

  it("reports an aborted run as unknown, not as a failure", async () => {
    const controller = new AbortController()
    controller.abort()
    const results = await runMonitoringChecks({
      statusPageUrl: PAGE,
      apiBase: API,
      signal: controller.signal,
      fetchImpl: (_url, init) => Promise.reject(init?.signal?.reason),
    })
    for (const result of results)
      expect(result).toMatchObject({ result: "unknown", reason: "runner_error" })
  })
})
