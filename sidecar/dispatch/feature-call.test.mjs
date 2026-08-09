import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createFeatureCallHandler, discoverOpenCodeV2Service } from "./feature-call.mjs"

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test("correlates concurrent generate calls and emits usage", async () => {
  const events = []
  const first = deferred()
  const second = deferred()
  const models = new Map([
    ["m1", { doGenerate: () => first.promise }],
    ["m2", { doGenerate: () => second.promise }],
  ])
  const handler = createFeatureCallHandler({
    emit: (event) => events.push(event),
    buildModel: async ({ model }) => models.get(model),
  })

  const a = handler.call({
    type: "feature_call",
    requestId: "a",
    operation: "language-generate",
    model: "m1",
    credentials: { secretAccessKey: "never-emit" },
    options: {},
  })
  const b = handler.call({
    type: "feature_call",
    requestId: "b",
    operation: "language-generate",
    model: "m2",
    credentials: {},
    options: {},
  })
  second.resolve({
    content: [],
    finishReason: "stop",
    usage: { inputTokens: 2, outputTokens: 3 },
    warnings: [],
  })
  first.resolve({
    content: [],
    finishReason: "stop",
    usage: { inputTokens: 5, outputTokens: 8 },
    warnings: [],
  })
  await Promise.all([a, b])

  assert.deepEqual(events.map((event) => event.requestId).sort(), ["a", "b"])
  assert.equal(
    events.every((event) => event.type === "feature_call_result"),
    true
  )
  assert.equal(JSON.stringify(events).includes("never-emit"), false)
})

test("streams model events and a terminal completion", async () => {
  const events = []
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "text-start", id: "1" })
      controller.enqueue({ type: "text-delta", id: "1", delta: "hello" })
      controller.close()
    },
  })
  const handler = createFeatureCallHandler({
    emit: (event) => events.push(event),
    buildModel: async () => ({ doStream: async () => ({ stream }) }),
  })

  await handler.call({
    type: "feature_call",
    requestId: "stream-1",
    operation: "language-stream",
    model: "m",
    credentials: {},
    options: {},
  })

  assert.deepEqual(events, [
    { type: "feature_call_stream", requestId: "stream-1", part: { type: "text-start", id: "1" } },
    {
      type: "feature_call_stream",
      requestId: "stream-1",
      part: { type: "text-delta", id: "1", delta: "hello" },
    },
    { type: "feature_call_stream_end", requestId: "stream-1" },
  ])
})

test("streams declarative adapter chunks through the LanguageModelV3 contract", async () => {
  const events = []
  const spec = { kind: "openai-compatible-variant", urlTemplate: "https://example.test" }
  let received
  const handler = createFeatureCallHandler({
    emit: (event) => events.push(event),
    resolveProtocolAdapter: (protocol, adapterSpec) => {
      assert.equal(protocol, "plugin:variant")
      assert.equal(adapterSpec, spec)
      return {
        async start(request) {
          received = request
          return {
            fullStream: (async function* () {
              yield { type: "text-delta", text: "hello" }
              yield {
                type: "finish",
                finishReason: "stop",
                usage: { promptTokens: 3, completionTokens: 2 },
              }
            })(),
          }
        },
      }
    },
  })

  await handler.call({
    type: "feature_call",
    requestId: "variant-1",
    operation: "language-stream",
    providerId: "plugin-provider",
    model: "model-1",
    credentials: { protocol: "plugin:variant", apiKey: "ephemeral" },
    protocolAdapterSpec: spec,
    options: {
      prompt: [{ role: "user", content: [{ type: "text", text: "diagnostic" }] }],
      maxOutputTokens: 64,
    },
  })

  assert.deepEqual(received.messages, [
    { role: "user", content: [{ type: "text", text: "diagnostic" }] },
  ])
  assert.equal(received.modelParams.maxOutputTokens, 64)
  assert.equal(received.credentials.apiKey, "ephemeral")
  assert.deepEqual(
    events.filter((event) => event.type === "feature_call_stream").map((event) => event.part.type),
    ["text-start", "text-delta", "text-end", "finish"]
  )
  assert.deepEqual(events.at(-2).part.usage, {
    inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 2, text: 2, reasoning: undefined },
  })
  assert.deepEqual(events.at(-1), { type: "feature_call_stream_end", requestId: "variant-1" })
})

test("reads cache/reasoning counts from the canonical AI SDK token-detail objects", async () => {
  // AI SDK 7 removes the deprecated top-level `cachedInputTokens` /
  // `cacheCreationInputTokens` / `reasoningTokens` mirrors; only the
  // `*TokenDetails` objects survive, and they must still normalize.
  const events = []
  const handler = createFeatureCallHandler({
    emit: (event) => events.push(event),
    resolveProtocolAdapter: () => ({
      async start() {
        return {
          fullStream: (async function* () {
            yield {
              type: "finish",
              finishReason: "stop",
              usage: {
                inputTokens: 100,
                outputTokens: 40,
                inputTokenDetails: { cacheReadTokens: 60, cacheWriteTokens: 25 },
                outputTokenDetails: { reasoningTokens: 15 },
              },
            }
          })(),
        }
      },
    }),
  })

  await handler.call({
    type: "feature_call",
    requestId: "details-1",
    operation: "language-stream",
    providerId: "plugin-provider",
    model: "model-1",
    credentials: { protocol: "plugin:variant", apiKey: "ephemeral" },
    protocolAdapterSpec: { kind: "openai-compatible-variant", urlTemplate: "https://example.test" },
    options: { prompt: [{ role: "user", content: [{ type: "text", text: "diagnostic" }] }] },
  })

  assert.deepEqual(events.at(-2).part.usage, {
    inputTokens: { total: 100, noCache: 40, cacheRead: 60, cacheWrite: 25 },
    outputTokens: { total: 40, text: 25, reasoning: 15 },
  })
})

test("correlates code adapter chunks and aborts their renderer bridge", async () => {
  const events = []
  const handler = createFeatureCallHandler({ emit: (event) => events.push(event) })
  const pending = handler.call({
    type: "feature_call",
    requestId: "code-1",
    operation: "language-stream",
    providerId: "plugin-provider",
    model: "model-1",
    credentials: { protocol: "plugin:custom" },
    protocolAdapterSpec: { kind: "code", pluginId: "plugin", adapterId: "custom" },
    options: { prompt: [{ role: "user", content: [{ type: "text", text: "diagnostic" }] }] },
  })

  await new Promise((resolve) => setImmediate(resolve))
  const exec = events.find((event) => event.type === "protocol_adapter_exec")
  assert.equal(exec.sessionId, "feature:code-1")
  assert.equal(
    handler.handleProtocolAdapterMessage({
      type: "protocol_adapter_chunk",
      sessionId: exec.sessionId,
      execId: exec.execId,
      chunk: { type: "text-delta", text: "native" },
    }),
    true
  )
  handler.handleProtocolAdapterMessage({
    type: "protocol_adapter_done",
    sessionId: exec.sessionId,
    execId: exec.execId,
    usage: { promptTokens: 2, completionTokens: 1 },
  })
  await pending
  assert.equal(
    events.some(
      (event) => event.type === "feature_call_stream" && event.part.type === "text-delta"
    ),
    true
  )

  const aborted = handler.call({
    type: "feature_call",
    requestId: "code-2",
    operation: "language-stream",
    model: "model-1",
    credentials: { protocol: "plugin:custom" },
    protocolAdapterSpec: { kind: "code", pluginId: "plugin", adapterId: "custom" },
    options: { prompt: [] },
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(handler.abort("code-2"), true)
  await aborted
  assert.equal(
    events.some((event) => event.type === "protocol_adapter_cancel" && event.reason === "aborted"),
    true
  )
})

test("abort cancels the correlated request without affecting another call", async () => {
  const events = []
  const handler = createFeatureCallHandler({
    emit: (event) => events.push(event),
    buildModel: async ({ model }) => ({
      doGenerate: ({ abortSignal }) =>
        model === "fast"
          ? Promise.resolve({ content: [], finishReason: "stop", usage: {}, warnings: [] })
          : new Promise((_, reject) => {
              abortSignal.addEventListener("abort", () => reject(abortSignal.reason), {
                once: true,
              })
            }),
    }),
  })
  const slow = handler.call({
    type: "feature_call",
    requestId: "slow",
    operation: "language-generate",
    model: "slow",
    credentials: {},
    options: {},
  })
  const fast = handler.call({
    type: "feature_call",
    requestId: "fast",
    operation: "language-generate",
    model: "fast",
    credentials: {},
    options: {},
  })
  assert.equal(handler.abort("slow"), true)
  await Promise.all([slow, fast])

  assert.equal(
    events.some((event) => event.type === "feature_call_aborted" && event.requestId === "slow"),
    true
  )
  assert.equal(
    events.some((event) => event.type === "feature_call_result" && event.requestId === "fast"),
    true
  )
})

test("credential-chain failures are actionable and scrub configured secrets", async () => {
  const events = []
  const handler = createFeatureCallHandler({
    emit: (event) => events.push(event),
    buildModel: async () => {
      throw new Error("failed for secret-value")
    },
  })
  await handler.call({
    type: "feature_call",
    requestId: "fail",
    operation: "language-generate",
    model: "m",
    credentials: { secretAccessKey: "secret-value" },
    options: {},
  })

  assert.deepEqual(events, [
    {
      type: "feature_call_error",
      requestId: "fail",
      error: "failed for [REDACTED]",
    },
  ])
})

test("executes Bedrock embeddings through the correlated feature channel", async () => {
  const events = []
  const handler = createFeatureCallHandler({
    emit: (event) => events.push(event),
    buildEmbeddingModel: async () => ({
      doEmbed: async ({ values }) => ({
        embeddings: values.map(() => ({ values: [0.1, 0.2] })),
        warnings: [],
      }),
    }),
  })
  await handler.call({
    type: "feature_call",
    requestId: "embed-1",
    operation: "embedding",
    model: "amazon.titan-embed-text-v2:0",
    credentials: { bedrockAuthMode: "default-chain", region: "us-east-1" },
    options: { values: ["safe text"] },
  })
  assert.deepEqual(events, [
    {
      type: "feature_call_result",
      requestId: "embed-1",
      result: { embeddings: [{ values: [0.1, 0.2] }], warnings: [] },
    },
  ])
})

test("discovers OpenCode V2 without persisting or logging authentication headers", async () => {
  const events = []
  const handler = createFeatureCallHandler({
    emit: (event) => events.push(event),
    discoverOpenCodeV2: async () => ({
      endpoint: "http://127.0.0.1:4096",
      version: "2.0.0-beta.1",
      headers: { authorization: "Bearer ephemeral" },
    }),
  })

  await handler.call({
    type: "feature_call",
    requestId: "opencode-v2",
    operation: "opencode-v2-discover",
    credentials: {},
  })

  assert.deepEqual(events, [
    {
      type: "feature_call_result",
      requestId: "opencode-v2",
      result: {
        endpoint: "http://127.0.0.1:4096",
        version: "2.0.0-beta.1",
        headers: { authorization: "Bearer ephemeral" },
      },
    },
  ])
})

test("discovers MCP capabilities through the client-managed runtime gateway", async () => {
  const events = []
  let received
  const handler = createFeatureCallHandler({
    emit: (event) => events.push(event),
    discoverMcpServer: async (server, options) => {
      received = { server, signal: options.signal }
      return {
        ok: true,
        toolCount: 1,
        tools: [{ name: "search" }],
        resources: [],
        prompts: [],
        durationMs: 4,
      }
    },
  })

  await handler.call({
    type: "feature_call",
    requestId: "mcp-1",
    operation: "mcp-discover",
    credentials: {},
    mcpServer: {
      id: "srv-1",
      name: "docs",
      transport: "http",
      config: { url: "https://mcp.example/rpc", headers: { authorization: "ephemeral" } },
    },
  })

  assert.equal(received.server.id, "srv-1")
  assert.equal(received.signal instanceof AbortSignal, true)
  assert.deepEqual(events, [
    {
      type: "feature_call_result",
      requestId: "mcp-1",
      result: {
        ok: true,
        toolCount: 1,
        tools: [{ name: "search" }],
        resources: [],
        prompts: [],
        durationMs: 4,
      },
    },
  ])
})

test("validates the discovered OpenCode V2 endpoint and derives its version from health", async () => {
  const endpoint = {
    url: "http://127.0.0.1:4096",
    auth: { type: "basic", username: "opencode", password: "ephemeral" },
  }
  const result = await discoverOpenCodeV2Service({
    loadService: async () => ({
      Service: {
        discover: async () => endpoint,
        headers: (value) => {
          assert.equal(value, endpoint)
          return { authorization: "Basic ephemeral" }
        },
      },
    }),
    fetchImpl: async (url, options) => {
      assert.equal(url.toString(), "http://127.0.0.1:4096/api/health")
      assert.deepEqual(options.headers, { authorization: "Basic ephemeral" })
      return {
        ok: true,
        json: async () => ({ version: "2.0.0-beta.1", pid: 42 }),
      }
    },
  })

  assert.deepEqual(result, {
    endpoint: "http://127.0.0.1:4096",
    version: "2.0.0-beta.1",
    headers: { authorization: "Basic ephemeral" },
  })
})

test("uses the exact pinned OpenCode V2 Service contract in isolated state", async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), "cognia-opencode-v2-"))
  const previousStateHome = process.env.XDG_STATE_HOME
  const previousFetch = globalThis.fetch
  t.after(async () => {
    globalThis.fetch = previousFetch
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previousStateHome
    await rm(stateRoot, { recursive: true, force: true })
  })

  const serviceDirectory = join(stateRoot, "opencode")
  await mkdir(serviceDirectory, { recursive: true })
  await writeFile(
    join(serviceDirectory, "service.json"),
    JSON.stringify({
      id: "isolated-test",
      url: "http://127.0.0.1:4096",
      pid: 4242,
      version: "2.0.0-beta.1",
      password: "ephemeral",
    })
  )
  process.env.XDG_STATE_HOME = stateRoot
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ version: "2.0.0-beta.1", pid: 4242 }),
  })

  const result = await discoverOpenCodeV2Service()

  assert.equal(result.endpoint, "http://127.0.0.1:4096")
  assert.equal(result.version, "2.0.0-beta.1")
  assert.equal(
    result.headers.authorization,
    `Basic ${Buffer.from("opencode:ephemeral").toString("base64")}`
  )
})

test("reports actionable OpenCode V2 discovery and health failures", async () => {
  await assert.rejects(
    discoverOpenCodeV2Service({
      loadService: async () => ({
        Service: { discover: async () => undefined, headers: () => undefined },
      }),
    }),
    /opencode2 service start/
  )

  await assert.rejects(
    discoverOpenCodeV2Service({
      loadService: async () => ({
        Service: {
          discover: async () => ({ url: "http://127.0.0.1:4096" }),
          headers: () => undefined,
        },
      }),
      fetchImpl: async () => ({ ok: false, json: async () => ({ healthy: false }) }),
    }),
    /health probe failed/
  )

  await assert.rejects(
    discoverOpenCodeV2Service({
      loadService: async () => ({
        Service: {
          discover: async () => ({ url: "http://127.0.0.1:4096" }),
          headers: () => undefined,
        },
      }),
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ healthy: true, version: "2.0.0-beta.1" }),
      }),
    }),
    /incompatible health contract/
  )
})
