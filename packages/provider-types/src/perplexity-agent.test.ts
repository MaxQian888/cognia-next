import assert from "node:assert/strict"
import { createOpenAI } from "@ai-sdk/openai"
import { resolvePerplexityEndpoint, withPerplexityAgentFetch } from "./perplexity-agent"

const source = { id: 1, url: "https://example.com/news", title: "News", snippet: "Latest" }
const responseBody = () => ({
  id: "resp_1",
  created_at: 1792368000,
  model: "openai/gpt-6-luna",
  status: "completed",
  output: [
    { type: "search_results", results: [source] },
    {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Latest news [1]", annotations: [] }],
    },
  ],
  usage: {
    input_tokens: 11,
    output_tokens: 4,
    total_tokens: 15,
    input_tokens_details: { cache_read_input_tokens: 3 },
  },
})

test("Perplexity routing preserves old Sonar pins, explicit flavors and gateway URLs", () => {
  assert.deepEqual(resolvePerplexityEndpoint({ model: "preset/fast", apiFlavor: "responses" }), {
    baseURL: "https://api.perplexity.ai/v1",
    flavor: "responses",
  })
  assert.deepEqual(resolvePerplexityEndpoint({ model: "sonar-pro", apiFlavor: "chat" }), {
    baseURL: "https://api.perplexity.ai",
    flavor: "chat",
  })
  assert.deepEqual(
    resolvePerplexityEndpoint({
      model: "sonar-pro",
      apiFlavor: "responses",
      baseURL: "https://relay.example/custom/v1",
    }),
    { baseURL: "https://relay.example/custom/v1", flavor: "responses" }
  )
  assert.deepEqual(
    resolvePerplexityEndpoint({ model: "preset/fast", baseURL: "https://api.perplexity.ai" }),
    { baseURL: "https://api.perplexity.ai/v1", flavor: "responses" }
  )
  assert.deepEqual(
    resolvePerplexityEndpoint({ model: "sonar-pro", baseURL: "https://api.perplexity.ai/v1" }),
    { baseURL: "https://api.perplexity.ai", flavor: "chat" }
  )
  assert.deepEqual(
    resolvePerplexityEndpoint({ model: "sonar-pro", baseURL: "https://relay.example/custom/v1" }),
    { baseURL: "https://relay.example/custom/v1", flavor: "chat" }
  )
  assert.deepEqual(
    resolvePerplexityEndpoint({
      model: "preset/fast",
      apiFlavor: "chat",
      baseURL: "https://relay.example/v1",
    }),
    { baseURL: "https://relay.example/v1", flavor: "chat" }
  )
})

test("the real installed SDK sends a preset without a fabricated model and reads text, citations and usage", async () => {
  let request: Request | undefined
  const model = createOpenAI({
    apiKey: "test-key",
    baseURL: "https://api.perplexity.ai/v1",
    fetch: withPerplexityAgentFetch(async (input, init) => {
      request = new Request(input, init)
      return Response.json(responseBody())
    }),
  }).responses("preset/fast")
  const result = await model.doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "News?" }] }],
  })
  assert.ok(request)
  assert.equal(request.url, "https://api.perplexity.ai/v1/responses")
  const body = (await request.json()) as {
    preset?: string
    model?: string
    input: { content: { text: string }[] }[]
  }
  assert.equal(body.preset, "fast")
  assert.equal(body.model, undefined)
  const input = body.input[0]
  assert.ok(input)
  const content = input.content[0]
  assert.ok(content)
  assert.equal(content.text, "News?")
  assert.equal(request.headers.get("authorization"), "Bearer test-key")
  assert.ok(result.content.some((part) => part.type === "text" && part.text === "Latest news [1]"))
  assert.ok(
    result.content.some(
      (part) => part.type === "source" && part.sourceType === "url" && part.url === source.url
    )
  )
  assert.equal(result.usage.inputTokens.total, 11)
  assert.equal(result.usage.inputTokens.cacheRead, 3)
  assert.equal(result.usage.outputTokens.total, 4)
})

test("streaming handles byte boundaries, citations, text and usage through the actual SDK", async () => {
  const data = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`
  const sse = [
    data({
      type: "response.created",
      response: { id: "resp_1", created_at: 1792368000, model: "openai/gpt-6-luna" },
    }),
    data({
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "search_results", results: [source] },
    }),
    data({
      type: "response.output_item.added",
      output_index: 1,
      item: { id: "msg_1", type: "message" },
    }),
    data({
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 1,
      delta: "新消息",
    }),
    data({ type: "response.output_item.done", output_index: 1, item: responseBody().output[1] }),
    data({ type: "response.completed", response: responseBody() }),
    "data: [DONE]\r\n\r\n",
  ].join("")
  const bytes = new TextEncoder().encode(sse)
  const model = createOpenAI({
    apiKey: "test-key",
    baseURL: "https://api.perplexity.ai/v1",
    fetch: withPerplexityAgentFetch(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (let offset = 0; offset < bytes.length; offset += 7)
                controller.enqueue(bytes.slice(offset, offset + 7))
              controller.close()
            },
          }),
          { headers: { "content-type": "text/event-stream" } }
        )
    ),
  }).responses("preset/fast")
  const result = await model.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "News?" }] }],
  })
  const chunks = []
  for await (const chunk of result.stream) chunks.push(chunk)
  assert.ok(chunks.some((part) => part.type === "text-delta" && part.delta === "新消息"))
  assert.equal(chunks.filter((part) => part.type === "source").length, 1)
  const finish = chunks.find((part) => part.type === "finish")
  assert.equal(finish?.usage.inputTokens.total, 11)
  assert.equal(finish?.usage.inputTokens.cacheRead, 3)
  assert.equal(chunks.filter((part) => part.type === "error").length, 0)
})

test("passes provider failures, abort signals and non-Agent requests through", async () => {
  const controller = new AbortController()
  const failure = new Response("rate limited", { status: 429, headers: { "retry-after": "5" } })
  const wrapped = withPerplexityAgentFetch(async (_input, init) => {
    assert.equal(init?.signal, controller.signal)
    return failure
  })
  assert.equal(
    await wrapped("https://relay.example/v1/chat/completions", { signal: controller.signal }),
    failure
  )
  const failed = await withPerplexityAgentFetch(async () => failure)(
    "https://api.perplexity.ai/v1/responses",
    {
      method: "POST",
      body: JSON.stringify({ model: "preset/fast", input: "hi" }),
    }
  )
  assert.equal(failed, failure)
  const abort = new DOMException("Aborted", "AbortError")
  await assert.rejects(
    withPerplexityAgentFetch(async () => {
      throw abort
    })("https://api.perplexity.ai/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "preset/fast", input: "hi" }),
    }),
    (error) => error === abort
  )
})

test("empty and direct-model Agent responses remain valid and unknown presets fail before fetch", async () => {
  let body: unknown
  const model = createOpenAI({
    apiKey: "test-key",
    baseURL: "https://api.perplexity.ai/v1",
    fetch: withPerplexityAgentFetch(async (input, init) => {
      body = await new Request(input, init).json()
      return Response.json({ ...responseBody(), output: [] })
    }),
  }).responses("perplexity/sonar")
  const result = await model.doGenerate({ prompt: [] })
  assert.deepEqual(result.content, [])
  assert.equal((body as { model: string }).model, "perplexity/sonar")
  await assert.rejects(
    withPerplexityAgentFetch(async () => {
      assert.fail("must not fetch unknown presets")
    })("https://api.perplexity.ai/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "preset/unknown" }),
    }),
    /Unsupported Perplexity preset/
  )
})

test("streaming starts before upstream completion and cancelling the reader cancels upstream", async () => {
  let upstream: ReadableStreamDefaultController<Uint8Array> | undefined
  let cancelled = false
  let sentSignal: AbortSignal | null | undefined
  const abort = new AbortController()
  const response = await withPerplexityAgentFetch(async (input, init) => {
    sentSignal = new Request(input, init).signal
    return new Response(
      new ReadableStream({
        start(controller) {
          upstream = controller
        },
        cancel() {
          cancelled = true
        },
      }),
      { headers: { "content-type": "text/event-stream" } }
    )
  })("https://api.perplexity.ai/v1/responses", {
    method: "POST",
    body: JSON.stringify({ model: "preset/fast", input: "hi" }),
    signal: abort.signal,
  })
  const reader = response.body!.getReader()
  const first = reader.read()
  upstream!.enqueue(
    new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"hi"}\n\n')
  )
  assert.match(new TextDecoder().decode((await first).value), /"delta":"hi"/)
  abort.abort()
  assert.equal(sentSignal!.aborted, true)
  await reader.cancel()
  // Cancellation propagates through the TransformStream pipe asynchronously.
  await new Promise<void>((resolve) => queueMicrotask(resolve))
  assert.equal(cancelled, true)
})

test("stream error events survive and repeated search/source citations are emitted once", async () => {
  const events = [
    { type: "response.output_item.done", item: { type: "search_results", results: [source] } },
    {
      type: "response.output_text.annotation.added",
      annotation: {
        type: "url_citation",
        url: source.url,
        title: source.title,
        start_index: 0,
        end_index: 0,
      },
    },
    { type: "error", code: "server_error", message: "Upstream failed" },
  ]
  const response = await withPerplexityAgentFetch(
    async () =>
      new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      })
  )("https://api.perplexity.ai/v1/responses", {
    method: "POST",
    body: JSON.stringify({ model: "preset/fast" }),
  })
  const text = await response.text()
  assert.equal(text.match(/response.output_text.annotation.added/g)?.length, 1)
  assert.match(text, /Upstream failed/)
})
