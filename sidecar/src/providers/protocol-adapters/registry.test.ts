import { test } from "node:test"
import assert from "node:assert/strict"
import { BUILTIN_PROTOCOLS, isBuiltinProtocol, resolveAdapter } from "./registry.ts"

test("the builtin protocol set includes AI SDK families and native SIWC", () => {
  assert.deepEqual([...BUILTIN_PROTOCOLS].sort(), [
    "anthropic",
    "azure",
    "bedrock",
    "chatgpt-siwc",
    "cohere",
    "google",
    "mistral",
    "openai",
  ])
})

test("isBuiltinProtocol accepts builtins and rejects everything else", () => {
  for (const p of BUILTIN_PROTOCOLS) assert.equal(isBuiltinProtocol(p), true)
  assert.equal(isBuiltinProtocol("gemini"), false) // renderer-side name; maps to google upstream
  assert.equal(isBuiltinProtocol(null), false)
  assert.equal(isBuiltinProtocol(undefined), false)
  assert.equal(isBuiltinProtocol("my-plugin:wire"), false)
})

test("builtin protocols resolve to the ai-sdk adapter (spec ignored)", () => {
  const adapter = resolveAdapter("openai", { kind: "openai-compatible-variant" })
  assert.ok(adapter)
  assert.equal(adapter.id, "ai-sdk:openai")
})

test("non-builtin protocol with a variant spec resolves the declarative adapter", () => {
  const adapter = resolveAdapter("my-plugin:wire", {
    kind: "openai-compatible-variant",
    urlTemplate: "{baseURL}/chat/completions",
    responsePaths: { textDelta: "choices[0].delta.content" },
  })
  assert.ok(adapter)
  assert.equal(adapter.id, "declarative:openai-compatible-variant")
})

test("no protocol and no spec resolves to null", () => {
  assert.equal(resolveAdapter(null, undefined), null)
  assert.equal(resolveAdapter("mystery", undefined), null)
  assert.equal(resolveAdapter("mystery", { kind: "something-else" }), null)
})

test("SIWC registry never resolves through a declarative or direct transport", async () => {
  const missing = resolveAdapter("chatgpt-siwc", { kind: "openai-compatible-variant" })
  assert.ok(missing)
  await assert.rejects(
    missing.start({ model: "m", messages: [], credentials: { baseURL: "siwc://a/c" } }),
    /native Host/
  )
  let captured: Record<string, unknown> | undefined
  const wired = resolveAdapter("chatgpt-siwc", undefined, {
    emit() {},
    sessionId: "s",
    pendingProtocolExecs: new Map(),
    nativeCall: async () => {
      throw new Error("unexpected RPC")
    },
  })
  assert.ok(wired)
  await wired.start({
    model: "m",
    messages: [],
    credentials: { baseURL: "siwc://a/c" },
    streamTextFn(args) {
      captured = args
      return { stream: (async function* () {})() }
    },
  })
  assert.equal((captured!.model as { provider: string }).provider, "openai.responses")
})
