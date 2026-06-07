import { test } from "node:test"
import assert from "node:assert/strict"
import { BUILTIN_PROTOCOLS, isBuiltinProtocol, resolveAdapter } from "./registry.mjs"

test("the builtin protocol set matches the five @ai-sdk families", () => {
  assert.deepEqual([...BUILTIN_PROTOCOLS].sort(), [
    "anthropic",
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
