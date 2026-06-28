// Single source of truth for LLM provider→protocol mapping and the
// OpenAI Responses-vs-Chat endpoint decision.
//
// WHY THIS FILE EXISTS: the same two facts — "which AI SDK family does provider
// id X speak?" and "does this openai-protocol endpoint serve /responses or
// /chat/completions?" — used to be hand-copied across four call sites
// (sidecar/dispatch/ai-sdk.mjs, sidecar/.../ai-sdk-adapter.mjs, the renderer's
// packages/provider-core client.ts, and lib/ai/provider-consumption.ts). The
// copies DRIFTED (the renderer list had openrouter/codex/local-engines; the
// resolver list had xai/togetherai/fireworks/deepinfra) and a mismatch silently
// 404s a gateway. This module is the one place that knowledge lives now.
//
// CONSTRAINTS: zero dependencies, pure data + pure functions. The sidecar ships
// standalone (`sidecar/**` only, no compiled TS), so this MUST be a runtime
// `.mjs` under sidecar/. The renderer/CLI (TypeScript) import it directly — the
// repo idiom for "sidecar and renderer must agree" (see
// lib/claude/usage.compaction-parity.test.ts). `sidecar` cannot import `lib/`,
// so the dependency direction is always renderer/CLI → this file.

/**
 * The AI SDK families with a first-party `@ai-sdk/*` package. A protocol id NOT
 * in this set is either an alias (`gemini` → `google`, normalize first) or a
 * plugin-contributed adapter id resolved through the protocol-adapter registry.
 */
export const BUILTIN_PROTOCOL_NAMES = Object.freeze([
  "openai",
  "anthropic",
  "google",
  "mistral",
  "cohere",
  "azure",
  "bedrock",
])

const BUILTIN_PROTOCOL_SET = new Set(BUILTIN_PROTOCOL_NAMES)

/** Is `protocol` one of the first-party AI SDK families (vs a plugin adapter)? */
export function isBuiltInProtocol(protocol) {
  return typeof protocol === "string" && BUILTIN_PROTOCOL_SET.has(normalizeProtocol(protocol))
}

/**
 * `gemini` is the historical alias for the `google` AI SDK family. Normalize it
 * here, in the ONE place, so no call site has to special-case the alias again.
 */
export function normalizeProtocol(protocol) {
  return protocol === "gemini" ? "google" : protocol
}

/**
 * Built-in provider id → AI SDK protocol family. This is the UNION of every
 * prior hand-maintained copy, de-drifted. Every openai-compatible aggregator
 * (xai / togetherai / fireworks / deepinfra / openrouter / groq / deepseek /
 * the OpenCode + Codex subscription gateways) and every local inference engine
 * (ollama / lmstudio / llamacpp / … — all expose an OpenAI-compatible `/v1`
 * surface) maps to "openai" and dispatches through the openai client with a
 * custom baseURL. Custom provider ids aren't here; they carry an explicit
 * `providerCredentials.protocol`.
 */
export const PROVIDER_PROTOCOL = Object.freeze({
  // Native first-party families.
  anthropic: "anthropic",
  google: "google",
  gemini: "google",
  mistral: "mistral",
  cohere: "cohere",
  azure: "azure",
  bedrock: "bedrock",
  // Genuine OpenAI + every OpenAI-compatible gateway / aggregator.
  openai: "openai",
  openrouter: "openai",
  opencode: "openai",
  "opencode-go": "openai",
  codex: "openai",
  deepseek: "openai",
  groq: "openai",
  "mistral-openai-compat": "openai",
  xai: "openai",
  togetherai: "openai",
  fireworks: "openai",
  deepinfra: "openai",
  // Local inference engines (OpenAI-compatible /v1 over a localhost port).
  ollama: "openai",
  lmstudio: "openai",
  llamacpp: "openai",
  llamafile: "openai",
  vllm: "openai",
  localai: "openai",
  jan: "openai",
  textgenwebui: "openai",
  koboldcpp: "openai",
  tabbyapi: "openai",
})

/**
 * Resolve a built-in provider id to its AI SDK protocol family. Returns null for
 * an unknown id — the caller must then rely on an explicit
 * `providerCredentials.protocol` (custom providers always carry one).
 */
export function resolveProviderProtocol(providerId) {
  return PROVIDER_PROTOCOL[providerId] ?? null
}

/**
 * Provider ids that serve the OpenAI Responses API ONLY (never
 * `/chat/completions`), regardless of host. Codex's ChatGPT-login backend lives
 * at `chatgpt.com`, whose host fails the `*.openai.com` check, so it needs an
 * id-based override to reach `/responses`.
 */
export const RESPONSES_ONLY_PROVIDERS = new Set(["codex"])

/**
 * Decide whether an openai-protocol base URL is genuine OpenAI (api.openai.com),
 * which serves the modern Responses API, versus an OpenAI-*compatible* gateway
 * (DeepSeek / OpenCode / Groq / OpenRouter / Ollama / LM Studio / …) that only
 * implements Chat Completions. A missing base URL means the default OpenAI
 * endpoint. Anything that doesn't parse, or whose host isn't *.openai.com, is
 * treated as a compatible gateway so we fail safe onto `/chat/completions`.
 */
export function isGenuineOpenAiEndpoint(baseURL) {
  if (!baseURL || typeof baseURL !== "string") return true
  try {
    const host = new URL(baseURL).host.toLowerCase()
    return host === "api.openai.com" || host.endsWith(".openai.com")
  } catch {
    return false
  }
}

/**
 * The Codex ChatGPT-login backend (`chatgpt.com` / `chat.openai.com`) serves the
 * Responses API only — `/chat/completions` is removed there. Its host isn't
 * `*.openai.com`, so `isGenuineOpenAiEndpoint` would misroute it to Chat
 * Completions. Detect it explicitly so Codex subscription turns hit `/responses`.
 */
export function isResponsesOnlyEndpoint(baseURL) {
  if (!baseURL || typeof baseURL !== "string") return false
  try {
    const host = new URL(baseURL).host.toLowerCase()
    return host === "chatgpt.com" || host === "chat.openai.com"
  } catch {
    return false
  }
}

/**
 * THE single decision for "build this openai/azure model via `.responses()` or
 * `.chat()`?". Used by both the sidecar (`ai-sdk-adapter.mjs:buildModel`) and the
 * renderer (`provider-core/client.ts:getProviderModel`) so they never disagree.
 *
 * Precedence:
 *   1. An explicit user `apiFlavor` ("responses" | "chat") always wins — this is
 *      what unlocks the Responses API on Azure OpenAI, on compatible gateways
 *      that proxy /responses, and on custom base URLs (the host heuristic alone
 *      can't know those serve it).
 *   2. "auto" (or undefined) falls back to the host/id heuristic: responses-only
 *      providers and genuine *.openai.com / chatgpt.com → "responses"; every
 *      other endpoint (compatible gateways, Azure with no explicit flavor) →
 *      "chat", the universally-supported default.
 *
 * @param {{ apiFlavor?: "auto"|"responses"|"chat", baseURL?: string, providerId?: string }} [args]
 * @returns {"responses"|"chat"}
 */
export function decideOpenAiEndpointFlavor({ apiFlavor, baseURL, providerId } = {}) {
  if (apiFlavor === "responses") return "responses"
  if (apiFlavor === "chat") return "chat"
  if (providerId && RESPONSES_ONLY_PROVIDERS.has(providerId)) return "responses"
  if (isResponsesOnlyEndpoint(baseURL)) return "responses"
  if (isGenuineOpenAiEndpoint(baseURL)) return "responses"
  return "chat"
}
