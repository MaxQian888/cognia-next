import assert from "node:assert/strict"
import { test } from "node:test"
import {
  createSiwcFetch,
  encodeSiwcReference,
  decodeSiwcReference,
  SIWC_RESPONSES_BASE_URL,
} from "./siwc-fetch.ts"

test("SIWC references round trip without interpreting accounts as URL hosts", () => {
  const ref = { localAccountId: "Account_A", connectionId: "connection/one" }
  assert.deepEqual(decodeSiwcReference(encodeSiwcReference(ref)), ref)
  for (const value of [
    undefined,
    "https://api.openai.com/v1",
    "siwc://a/b/c",
    "siwc://a/b?token=x",
    "siwc://a/",
  ]) {
    assert.throws(() => decodeSiwcReference(value), /SIWC/)
  }
})

test("SIWC fetch streams through native RPC and never forwards SDK authorization", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const chunks = [
    Buffer.from("data: first\n\n").toString("base64"),
    Buffer.from("data: second\n\n").toString("base64"),
  ]
  const fetch = createSiwcFetch(
    { localAccountId: "a", connectionId: "c" },
    async (method, params) => {
      calls.push({ method, params })
      if (method.endsWith("open"))
        return { streamId: "s", status: 200, headers: { "content-type": "text/event-stream" } }
      if (method.endsWith("read"))
        return chunks.length ? { done: false, chunkBase64: chunks.shift() } : { done: true }
      return null
    }
  )
  const response = await fetch(`${SIWC_RESPONSES_BASE_URL}/responses`, {
    method: "POST",
    headers: { Authorization: "Bearer SDK-placeholder" },
    body: '{"model":"m","input":"hello"}',
  })
  assert.equal(await response.text(), "data: first\n\ndata: second\n\n")
  assert.equal(calls[0]!.method, "siwc.responses.open")
  assert.equal(calls[0]!.params.body, '{"model":"m","input":"hello"}')
  assert.equal(JSON.stringify(calls).includes("SDK-placeholder"), false)
})

test("SIWC fetch refuses other endpoints, invalid JSON and pre-aborted requests", async () => {
  let calls = 0
  const fetch = createSiwcFetch({ localAccountId: "a", connectionId: "c" }, async () => {
    calls++
    return null
  })
  await assert.rejects(
    fetch("https://api.openai.com/v1/responses", { method: "POST", body: "{}" }),
    /SIWC/
  )
  await assert.rejects(
    fetch(`${SIWC_RESPONSES_BASE_URL}/responses`, { method: "POST", body: "not-json" }),
    /JSON/
  )
  await assert.rejects(
    fetch(`${SIWC_RESPONSES_BASE_URL}/responses`, {
      method: "POST",
      body: "{}",
      signal: AbortSignal.abort(),
    }),
    { name: "AbortError" }
  )
  assert.equal(calls, 0)
})

test("abort during native open cancels by request id and closes the late stream", async () => {
  let finish!: (value: unknown) => void
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const controller = new AbortController()
  const fetch = createSiwcFetch(
    { localAccountId: "a", connectionId: "c" },
    async (method, params) => {
      calls.push({ method, params })
      if (method.endsWith("open"))
        return new Promise((resolve) => {
          finish = resolve
        })
      return null
    }
  )
  const pending = fetch(`${SIWC_RESPONSES_BASE_URL}/responses`, {
    method: "POST",
    body: "{}",
    signal: controller.signal,
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  controller.abort()
  await assert.rejects(pending, { name: "AbortError" })
  finish({ streamId: "late", status: 200, headers: {} })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(
    calls.some(
      (call) => call.method.endsWith("cancel") && typeof call.params.requestId === "string"
    )
  )
  assert.ok(calls.some((call) => call.method.endsWith("cancel") && call.params.streamId === "late"))
})

test("reader cancellation releases the native stream and errors never call a fallback", async () => {
  const calls: string[] = []
  const fetch = createSiwcFetch({ localAccountId: "a", connectionId: "c" }, async (method) => {
    calls.push(method)
    if (method.endsWith("open")) return { streamId: "s", status: 200, headers: {} }
    if (method.endsWith("read")) throw new Error("native connection unavailable")
    return null
  })
  const response = await fetch(`${SIWC_RESPONSES_BASE_URL}/responses`, {
    method: "POST",
    body: "{}",
  })
  await assert.rejects(response.text(), /native connection unavailable/)
  assert.ok(calls.includes("siwc.responses.cancel"))
})

test("SIWC abort after headers cancels pending body reads", async () => {
  const controller = new AbortController()
  let cancelled = false
  const fetch = createSiwcFetch({ localAccountId: "a", connectionId: "c" }, async (method) => {
    if (method.endsWith("open")) return { streamId: "s", status: 200, headers: {} }
    if (method.endsWith("read")) return new Promise(() => {})
    cancelled = true
    return null
  })
  const response = await fetch(`${SIWC_RESPONSES_BASE_URL}/responses`, {
    method: "POST",
    body: "{}",
    signal: controller.signal,
  })
  const text = response.text()
  controller.abort()
  await assert.rejects(text, { name: "AbortError" })
  assert.equal(cancelled, true)
})

test("concurrent SIWC requests have distinct cancellation identities and isolated connections", async () => {
  const requests: Record<string, unknown>[] = []
  const call = async (method: string, params: Record<string, unknown>) => {
    if (method.endsWith("open")) {
      requests.push(params)
      return { streamId: params.requestId, status: 200, headers: {} }
    }
    return { done: true }
  }
  const first = createSiwcFetch({ localAccountId: "local-a", connectionId: "one" }, call)
  const second = createSiwcFetch({ localAccountId: "local-b", connectionId: "two" }, call)
  const responses = await Promise.all(
    [first, second].map((fetch) =>
      fetch(`${SIWC_RESPONSES_BASE_URL}/responses`, { method: "POST", body: "{}" })
    )
  )
  await Promise.all(responses.map((response) => response.text()))
  assert.notEqual(requests[0]!.requestId, requests[1]!.requestId)
  assert.deepEqual(
    requests.map((request) => [request.localAccountId, request.connectionId]),
    [
      ["local-a", "one"],
      ["local-b", "two"],
    ]
  )
})
