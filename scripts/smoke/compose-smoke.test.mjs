import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { waitForBrainReady } from "./compose-smoke.mjs"

test("waits for required readiness even after bridge hello and tolerates optional degradation", async (t) => {
  const responses = [
    new Response(JSON.stringify({ status: "not_ready", checks: { bootstrapped: false } }), {
      status: 503,
    }),
    new Response(
      JSON.stringify({ status: "not_ready", checks: { failedRequiredRuntimes: ["scheduler"] } }),
      { status: 503 }
    ),
    new Response(
      JSON.stringify({ status: "ready", degraded: true, failedRuntimes: ["backup-scheduler"] })
    ),
  ]
  const urls = []
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(url)
    return responses.shift()
  })
  const ready = await waitForBrainReady({ tries: 3, intervalMs: 0 })
  assert.equal(ready.degraded, true)
  assert.equal(urls.length, 3)
  assert.ok(urls.every((url) => url.endsWith("/readyz")))
})

test("fails smoke with required runtime diagnostics when readiness never recovers", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          status: "not_ready",
          checks: { failedRequiredRuntimes: ["scheduler"] },
        }),
        { status: 503 }
      )
  )
  await assert.rejects(waitForBrainReady({ tries: 1, intervalMs: 0 }), /scheduler/)
})

test("readiness probes cannot restart a healthy server process", () => {
  const kube = readFileSync(
    new URL("../../deploy/k8s/base/cognia-server.yaml", import.meta.url),
    "utf8"
  )
  for (const probe of ["startupProbe", "livenessProbe"]) {
    assert.match(kube, new RegExp(`${probe}:\\s+httpGet:\\s+path: /livez`))
  }
  assert.match(kube, /readinessProbe:\s+httpGet:\s+path: \/readyz/)
  for (const file of [
    "docker-compose.yml",
    "docker-compose.web-headless-e2e.yml",
    "compose.production.yaml",
  ]) {
    const compose = readFileSync(new URL(`../../deploy/compose/${file}`, import.meta.url), "utf8")
    assert.ok(compose.includes("https://localhost:27890/readyz"), file)
    assert.ok(!compose.includes("https://localhost:27890/healthz"), file)
    assert.ok(!compose.includes("autoheal"), file)
  }
})
