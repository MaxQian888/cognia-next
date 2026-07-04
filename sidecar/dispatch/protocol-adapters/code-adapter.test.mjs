import { test } from "node:test"
import assert from "node:assert/strict"
import { makeCodeAdapter, registerProtocolExec } from "./code-adapter.mjs"

async function collect(iterable) {
  const out = []
  for await (const e of iterable) out.push(e)
  return out
}

test("registerProtocolExec streams pushed chunks then finishes with usage", async () => {
  const pending = new Map()
  const channel = registerProtocolExec(pending, "ex1")
  assert.ok(pending.has("ex1"))
  channel.push({ type: "text-delta", text: "Hel" })
  channel.push({ type: "text-delta", text: "lo" })
  channel.finish({ promptTokens: 5, completionTokens: 2 })
  const events = await collect(channel.fullStream)
  assert.deepEqual(events, [
    { type: "text-delta", text: "Hel" },
    { type: "text-delta", text: "lo" },
  ])
  assert.deepEqual(await channel.usage, { promptTokens: 5, completionTokens: 2 })
})

test("fail() emits an error event and closes the stream", async () => {
  const channel = registerProtocolExec(new Map(), "ex2")
  channel.push({ type: "text-delta", text: "partial" })
  channel.fail("upstream 500")
  const events = await collect(channel.fullStream)
  assert.deepEqual(events.at(-1), { type: "error", error: "upstream 500" })
  assert.equal(await channel.usage, null)
})

test("cancel() closes the stream, settles usage, and notifies the renderer", async () => {
  const emitted = []
  const channel = registerProtocolExec(new Map(), "ex-cancel", {
    onCancel: (execId, reason) => emitted.push({ execId, reason }),
  })
  channel.push({ type: "text-delta", text: "partial" })
  channel.cancel("interrupted")
  const events = await collect(channel.fullStream)

  assert.deepEqual(events, [{ type: "text-delta", text: "partial" }])
  assert.equal(await channel.usage, null)
  assert.deepEqual(emitted, [{ execId: "ex-cancel", reason: "interrupted" }])
})

test("finish after cancel is ignored", async () => {
  const channel = registerProtocolExec(new Map(), "ex-cancel")
  channel.cancel("interrupted")
  channel.finish({ promptTokens: 5 })

  assert.deepEqual(await collect(channel.fullStream), [])
  assert.equal(await channel.usage, null)
})

test("makeCodeAdapter emits protocol_adapter_exec and returns the channel stream", async () => {
  const emitted = []
  const pending = new Map()
  const adapter = makeCodeAdapter(
    { kind: "code", pluginId: "acme", adapterId: "acme:wire" },
    {
      emit: (m) => emitted.push(m),
      sessionId: "s1",
      pendingProtocolExecs: pending,
      makeExecId: () => "fixed-exec",
      onCancel: (execId, reason) =>
        emitted.push({ type: "protocol_adapter_cancel", execId, reason }),
    }
  )
  assert.equal(adapter.id, "code:acme:acme:wire")

  const result = await adapter.start({
    model: "acme-1",
    messages: [{ role: "user", content: "hi" }],
    modelParams: { temperature: 0.2 },
    credentials: { apiKey: "k", baseURL: "https://x" },
  })

  const exec = emitted.find((m) => m.type === "protocol_adapter_exec")
  assert.ok(exec)
  assert.equal(exec.execId, "fixed-exec")
  assert.equal(exec.pluginId, "acme")
  assert.equal(exec.adapterId, "acme:wire")
  assert.equal(exec.request.model, "acme-1")
  assert.deepEqual(exec.request.modelParams, { temperature: 0.2 })

  // The host drives the registered channel; the adapter's fullStream sees it.
  const channel = pending.get("fixed-exec")
  channel.push({ type: "text-delta", text: "yo" })
  channel.finish({ promptTokens: 1 })
  const events = await collect(result.fullStream)
  assert.deepEqual(events, [{ type: "text-delta", text: "yo" }])
  assert.deepEqual(await result.usage, { promptTokens: 1 })
})

test("makeCodeAdapter forwards IPC-safe turn options to renderer code adapters", async () => {
  const emitted = []
  const adapter = makeCodeAdapter(
    { kind: "code", pluginId: "acme", adapterId: "acme:wire" },
    {
      emit: (m) => emitted.push(m),
      sessionId: "s1",
      pendingProtocolExecs: new Map(),
      makeExecId: () => "fixed-exec",
      onCancel: (execId, reason) =>
        emitted.push({ type: "protocol_adapter_cancel", execId, reason }),
    }
  )

  await adapter.start({
    model: "acme-1",
    messages: [
      {
        role: "user",
        content: "hi",
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      },
    ],
    modelParams: { temperature: 0.2 },
    credentials: {
      apiKey: "k",
      baseURL: "https://x",
      protocol: "acme:wire",
      headers: { "x-acme-account": "acct_1" },
      apiFlavor: "responses",
    },
    reasoning: { effort: "high", maxThinkingTokens: 4096 },
    maxSteps: 3,
    abortSignal: new AbortController().signal,
    streamTextFn: () => {
      throw new Error("test-only function must not cross IPC")
    },
    stopWhenExtra: () => true,
  })

  const exec = emitted.find((m) => m.type === "protocol_adapter_exec")
  assert.ok(exec)
  assert.deepEqual(exec.request, {
    model: "acme-1",
    messages: [
      {
        role: "user",
        content: "hi",
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      },
    ],
    modelParams: { temperature: 0.2 },
    credentials: {
      apiKey: "k",
      baseURL: "https://x",
      protocol: "acme:wire",
      headers: { "x-acme-account": "acct_1" },
      apiFlavor: "responses",
    },
    reasoning: { effort: "high", maxThinkingTokens: 4096 },
    maxSteps: 3,
  })
})
