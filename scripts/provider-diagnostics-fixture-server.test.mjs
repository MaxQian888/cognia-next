import assert from "node:assert/strict"
import test from "node:test"

import { startProviderDiagnosticsFixtureServer } from "./provider-diagnostics-fixture-server.mjs"

test("emulates protocol, embedding, balance, rate-limit, malformed, TTFT, and cancellation paths", async () => {
  const fixture = await startProviderDiagnosticsFixtureServer()
  try {
    assert.equal((await fetch(`${fixture.baseUrl}/v1/models`)).status, 200)
    assert.equal((await fetch(`${fixture.baseUrl}/v1/embeddings`, { method: "POST" })).status, 200)
    assert.equal((await fetch(`${fixture.baseUrl}/balance/absolute`)).status, 200)
    const limited = await fetch(`${fixture.baseUrl}/rate-limit`)
    assert.equal(limited.status, 429)
    assert.equal(limited.headers.get("retry-after"), "3")
    assert.match(await (await fetch(`${fixture.baseUrl}/malformed-stream`)).text(), /not-json/)
    const started = Date.now()
    await (await fetch(`${fixture.baseUrl}/delayed-ttft`)).text()
    assert.ok(Date.now() - started >= 70)
    const controller = new AbortController()
    const cancellable = await fetch(`${fixture.baseUrl}/cancellable`, { signal: controller.signal })
    const reader = cancellable.body.getReader()
    await reader.read()
    controller.abort()
    await assert.rejects(reader.read(), /abort/i)
  } finally {
    await fixture.close()
  }
})
