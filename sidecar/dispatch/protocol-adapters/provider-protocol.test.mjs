import { test } from "node:test"
import assert from "node:assert/strict"
import { LOCAL_PROVIDER_NAMES } from "../../../packages/provider-types/src/local-provider.ts"
import {
  BUILTIN_PROTOCOL_NAMES,
  PROVIDER_PROTOCOL,
  RESPONSES_ONLY_PROVIDERS,
  OPENAI_HOST_PROVIDERS,
  isBuiltInProtocol,
  normalizeProtocol,
  resolveProviderProtocol,
  isGenuineOpenAiEndpoint,
  isResponsesOnlyEndpoint,
  isOpenAiNativeSurface,
  isMisroutedToOpenAi,
  decideOpenAiEndpointFlavor,
} from "./provider-protocol.mjs"

test("isOpenAiNativeSurface covers genuine OpenAI, the Codex backend, and codex relays", () => {
  // Genuine OpenAI (or the implicit default endpoint).
  assert.equal(isOpenAiNativeSurface({ baseURL: "https://api.openai.com/v1" }), true)
  assert.equal(isOpenAiNativeSurface({ providerId: "openai" }), true)
  // The Codex ChatGPT backend — host is NOT *.openai.com, so the host check alone misses it.
  assert.equal(isOpenAiNativeSurface({ baseURL: "https://chatgpt.com/backend-api/codex" }), true)
  // A codex account on an arbitrary relay preset: only the id identifies it.
  assert.equal(
    isOpenAiNativeSurface({ providerId: "codex", baseURL: "https://ai-pixel.online" }),
    true
  )
  // Compatible gateways are NOT native — they may 400 on OpenAI's proprietary fields.
  assert.equal(
    isOpenAiNativeSurface({ providerId: "deepseek", baseURL: "https://api.deepseek.com/v1" }),
    false
  )
  assert.equal(
    isOpenAiNativeSurface({ providerId: "ollama", baseURL: "http://localhost:11434/v1" }),
    false
  )
})

test("normalizeProtocol folds the gemini alias to google, passes everything else", () => {
  assert.equal(normalizeProtocol("gemini"), "google")
  assert.equal(normalizeProtocol("google"), "google")
  assert.equal(normalizeProtocol("openai"), "openai")
  assert.equal(normalizeProtocol("some-plugin:adapter"), "some-plugin:adapter")
})

test("isBuiltInProtocol recognizes the first-party families incl. the gemini alias", () => {
  for (const p of ["openai", "anthropic", "google", "mistral", "cohere", "azure", "bedrock"]) {
    assert.equal(isBuiltInProtocol(p), true, p)
  }
  assert.equal(isBuiltInProtocol("gemini"), true, "gemini normalizes to google")
  assert.equal(isBuiltInProtocol("acme:custom"), false)
  assert.equal(isBuiltInProtocol(undefined), false)
})

test("PROVIDER_PROTOCOL is the de-drifted union of every prior copy", () => {
  // Aggregators that were ONLY in the resolver's BUILTIN_PROTOCOLS copy.
  for (const id of ["xai", "togetherai", "fireworks", "deepinfra"]) {
    assert.equal(PROVIDER_PROTOCOL[id], "openai", id)
  }
  // Gateways/subscriptions that were ONLY in the renderer's compatible set.
  for (const id of ["openrouter", "opencode", "opencode-go", "codex", "deepseek", "groq"]) {
    assert.equal(PROVIDER_PROTOCOL[id], "openai", id)
  }
  // Every local engine maps to openai.
  for (const id of LOCAL_PROVIDER_NAMES) {
    assert.equal(PROVIDER_PROTOCOL[id], "openai", id)
  }
  // Native families.
  assert.equal(PROVIDER_PROTOCOL.anthropic, "anthropic")
  assert.equal(PROVIDER_PROTOCOL.google, "google")
  assert.equal(PROVIDER_PROTOCOL.gemini, "google")
  assert.equal(PROVIDER_PROTOCOL.mistral, "mistral")
  assert.equal(PROVIDER_PROTOCOL.cohere, "cohere")
  assert.equal(PROVIDER_PROTOCOL.azure, "azure")
  assert.equal(PROVIDER_PROTOCOL.bedrock, "bedrock")
})

test("resolveProviderProtocol returns null for unknown ids (caller uses explicit protocol)", () => {
  assert.equal(resolveProviderProtocol("openai"), "openai")
  assert.equal(resolveProviderProtocol("my-self-hosted"), null)
})

test("every PROVIDER_PROTOCOL value is a built-in protocol name", () => {
  for (const [id, proto] of Object.entries(PROVIDER_PROTOCOL)) {
    assert.ok(BUILTIN_PROTOCOL_NAMES.includes(normalizeProtocol(proto)), `${id} → ${proto}`)
  }
})

test("isGenuineOpenAiEndpoint distinguishes api.openai.com from compatible gateways", () => {
  assert.equal(isGenuineOpenAiEndpoint(undefined), true)
  assert.equal(isGenuineOpenAiEndpoint("https://api.openai.com/v1"), true)
  assert.equal(isGenuineOpenAiEndpoint("https://eu.api.openai.com/v1"), true)
  assert.equal(isGenuineOpenAiEndpoint("https://api.deepseek.com/v1"), false)
  assert.equal(isGenuineOpenAiEndpoint("http://localhost:11434/v1"), false)
  assert.equal(isGenuineOpenAiEndpoint("not a url"), false)
})

test("isResponsesOnlyEndpoint detects the Codex ChatGPT backend only", () => {
  assert.equal(isResponsesOnlyEndpoint("https://chatgpt.com/backend-api/codex"), true)
  assert.equal(isResponsesOnlyEndpoint("https://chat.openai.com/backend-api/codex"), true)
  assert.equal(isResponsesOnlyEndpoint("https://api.openai.com/v1"), false)
  assert.equal(isResponsesOnlyEndpoint(undefined), false)
})

test("isMisroutedToOpenAi flags an aggregator that would hit OpenAI, sparing genuine OpenAI/Codex", () => {
  // The reported bug: an OpenRouter key with no base URL would reach OpenAI.
  assert.equal(isMisroutedToOpenAi("openrouter", undefined), true)
  assert.equal(isMisroutedToOpenAi("openrouter", ""), true)
  assert.equal(isMisroutedToOpenAi("openrouter", "https://api.openai.com/v1"), true)
  // Other openai-compatible aggregators are caught the same way.
  for (const id of ["deepseek", "groq", "xai", "togetherai", "fireworks", "deepinfra"]) {
    assert.equal(isMisroutedToOpenAi(id, undefined), true, id)
  }
  // Local engines that lost their localhost URL would also leak — caught too.
  assert.equal(isMisroutedToOpenAi("ollama", undefined), true)
  // The provider's correct host is NOT a misroute.
  assert.equal(isMisroutedToOpenAi("openrouter", "https://openrouter.ai/api/v1"), false)
  assert.equal(isMisroutedToOpenAi("deepseek", "https://api.deepseek.com/v1"), false)
  // Genuine OpenAI + Codex legitimately dispatch to *.openai.com.
  assert.equal(isMisroutedToOpenAi("openai", undefined), false)
  assert.equal(isMisroutedToOpenAi("codex", "https://api.openai.com/v1"), false)
  assert.ok(OPENAI_HOST_PROVIDERS.has("openai") && OPENAI_HOST_PROVIDERS.has("codex"))
  // Non-openai protocols and unknown/custom ids are never flagged.
  assert.equal(isMisroutedToOpenAi("anthropic", undefined), false)
  assert.equal(isMisroutedToOpenAi("my-self-hosted", undefined), false)
  assert.equal(isMisroutedToOpenAi(undefined, undefined), false)
})

test("decideOpenAiEndpointFlavor: explicit apiFlavor always wins (unlocks Azure/gateway/custom)", () => {
  // Force responses on an endpoint the heuristic would call chat (Azure, gateway).
  assert.equal(
    decideOpenAiEndpointFlavor({ apiFlavor: "responses", baseURL: "https://x.openai.azure.com" }),
    "responses"
  )
  assert.equal(
    decideOpenAiEndpointFlavor({ apiFlavor: "responses", baseURL: "https://gateway.example/v1" }),
    "responses"
  )
  // Force chat even on genuine OpenAI.
  assert.equal(
    decideOpenAiEndpointFlavor({ apiFlavor: "chat", baseURL: "https://api.openai.com/v1" }),
    "chat"
  )
})

test("decideOpenAiEndpointFlavor: auto/undefined falls back to the host+id heuristic", () => {
  // Genuine OpenAI / no base URL → responses.
  assert.equal(decideOpenAiEndpointFlavor({ baseURL: undefined }), "responses")
  assert.equal(
    decideOpenAiEndpointFlavor({ apiFlavor: "auto", baseURL: "https://api.openai.com/v1" }),
    "responses"
  )
  // Codex id override → responses despite a non-*.openai.com host.
  assert.equal(
    decideOpenAiEndpointFlavor({
      apiFlavor: "auto",
      providerId: "codex",
      baseURL: "https://chatgpt.com/backend-api/codex",
    }),
    "responses"
  )
  // Compatible gateway / Azure with no explicit flavor → chat (safe default).
  assert.equal(decideOpenAiEndpointFlavor({ baseURL: "https://api.deepseek.com/v1" }), "chat")
  assert.equal(decideOpenAiEndpointFlavor({ baseURL: "https://x.openai.azure.com" }), "chat")
})
