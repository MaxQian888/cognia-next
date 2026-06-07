import { test } from "node:test"
import assert from "node:assert/strict"
import {
  makeOpenAiCompatVariantAdapter,
  SPEC_REQUIRED_KEYS,
  validateSpec,
} from "./openai-compatible-variant-adapter.mjs"

const SPEC = {
  kind: "openai-compatible-variant",
  urlTemplate: "{baseURL}/v2/chat",
  headers: { Authorization: "Bearer {apiKey}", "X-Custom": "static" },
  requestRenames: { maxOutputTokens: "max_tokens" },
  requestInject: { stream_options: { include_usage: true } },
  responsePaths: {
    textDelta: "choices[0].delta.content",
    reasoningDelta: "choices[0].delta.reasoning_content",
    finishReason: "choices[0].finish_reason",
    usage: { input: "usage.prompt_tokens", output: "usage.completion_tokens" },
  },
}

/** Build a fake fetch returning the given SSE payload lines. */
function fakeFetch(lines, { status = 200, headers = new Map() } = {}) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init })
    const encoder = new TextEncoder()
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k) => headers.get(k) ?? null },
      text: async () => lines.join("\n"),
      body: (async function* () {
        for (const line of lines) yield encoder.encode(`${line}\n`)
      })(),
    }
  }
  fn.calls = calls
  return fn
}

const REQ = (fetchFn) => ({
  model: "my-model",
  messages: [{ role: "user", content: "hi" }],
  modelParams: { temperature: 0.2, maxOutputTokens: 256 },
  credentials: { apiKey: "sk-secret", baseURL: "https://api.acme.dev/" },
  fetchFn,
})

async function collect(iterable) {
  const out = []
  for await (const e of iterable) out.push(e)
  return out
}

test("validateSpec accepts the canonical spec and rejects malformed ones", () => {
  assert.equal(validateSpec(SPEC), null)
  assert.match(validateSpec(null) ?? "", /object/)
  assert.match(validateSpec({ kind: "nope" }) ?? "", /unknown spec kind/)
  assert.match(validateSpec({ kind: SPEC.kind }) ?? "", /urlTemplate/)
  assert.match(
    validateSpec({ kind: SPEC.kind, urlTemplate: "u", responsePaths: {} }) ?? "",
    /textDelta/
  )
})

test("SPEC_REQUIRED_KEYS pins the contract for the renderer parity test", () => {
  assert.deepEqual(SPEC_REQUIRED_KEYS, ["kind", "urlTemplate", "responsePaths"])
})

test("interpolates url + headers, renames params, injects extras", async () => {
  const fetchFn = fakeFetch(["data: [DONE]"])
  const adapter = makeOpenAiCompatVariantAdapter(SPEC)
  const result = await adapter.start(REQ(fetchFn))
  await collect(result.fullStream)

  const { url, init } = fetchFn.calls[0]
  assert.equal(url, "https://api.acme.dev/v2/chat") // trailing slash trimmed
  assert.equal(init.headers["authorization"], "Bearer sk-secret")
  assert.equal(init.headers["x-custom"], "static")
  const body = JSON.parse(init.body)
  assert.equal(body.model, "my-model")
  assert.equal(body.stream, true)
  assert.equal(body.temperature, 0.2)
  assert.equal(body.max_tokens, 256) // renamed
  assert.equal("maxOutputTokens" in body, false)
  assert.deepEqual(body.stream_options, { include_usage: true }) // injected
})

test("maps SSE chunks to fullStream-shaped events matching the builtin path", async () => {
  const fetchFn = fakeFetch([
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "hmm" } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}`,
    "", // keep-alive blank line
    `data: ${JSON.stringify({ choices: [{ delta: { content: " world" } }] })}`,
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 9, completion_tokens: 4 },
    })}`,
    "data: [DONE]",
  ])
  const adapter = makeOpenAiCompatVariantAdapter(SPEC)
  const result = await adapter.start(REQ(fetchFn))
  const events = await collect(result.fullStream)

  assert.deepEqual(events, [
    { type: "reasoning-delta", id: "r0", text: "hmm" },
    { type: "text-delta", id: "0", text: "Hello" },
    { type: "text-delta", id: "0", text: " world" },
    {
      type: "finish",
      finishReason: "stop",
      usage: { promptTokens: 9, completionTokens: 4 },
    },
  ])
  assert.deepEqual(await result.usage, { promptTokens: 9, completionTokens: 4 })
})

test("tolerates unparseable data payloads and missing finish reason", async () => {
  const fetchFn = fakeFetch([
    "data: not-json",
    `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}`,
    "data: [DONE]",
  ])
  const adapter = makeOpenAiCompatVariantAdapter(SPEC)
  const result = await adapter.start(REQ(fetchFn))
  const events = await collect(result.fullStream)
  assert.equal(events[0].text, "ok")
  assert.equal(events.at(-1).type, "finish")
  assert.equal(events.at(-1).finishReason, "stop") // default
})

test("non-2xx responses throw with status + retry-after + body excerpt", async () => {
  const fetchFn = fakeFetch(["rate limited, slow down"], {
    status: 429,
    headers: new Map([["retry-after", "30"]]),
  })
  const adapter = makeOpenAiCompatVariantAdapter(SPEC)
  await assert.rejects(
    () => adapter.start(REQ(fetchFn)),
    (err) => {
      assert.match(err.message, /HTTP 429/)
      assert.match(err.message, /retry-after: 30/)
      assert.match(err.message, /rate limited/)
      return true
    }
  )
})

test("invalid specs throw at start", async () => {
  const adapter = makeOpenAiCompatVariantAdapter({ kind: "openai-compatible-variant" })
  await assert.rejects(() => adapter.start(REQ(fakeFetch([]))), /invalid protocol adapter spec/)
})

test("works without optional spec fields (minimal spec)", async () => {
  const minimal = {
    kind: "openai-compatible-variant",
    urlTemplate: "{baseURL}/chat",
    responsePaths: { textDelta: "choices[0].delta.content" },
  }
  const fetchFn = fakeFetch([
    `data: ${JSON.stringify({ choices: [{ delta: { content: "min" } }] })}`,
    "data: [DONE]",
  ])
  const adapter = makeOpenAiCompatVariantAdapter(minimal)
  const result = await adapter.start(REQ(fetchFn))
  const events = await collect(result.fullStream)
  assert.equal(events[0].text, "min")
  assert.deepEqual(await result.usage, {}) // no usage paths configured
})
