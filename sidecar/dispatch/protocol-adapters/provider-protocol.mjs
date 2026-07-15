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
 * Built-in openai-PROTOCOL provider ids that legitimately dispatch to an
 * `*.openai.com` host: genuine OpenAI itself, and Codex (whose API backend is
 * `api.openai.com/v1`). EVERY OTHER openai-protocol built-in — the cloud
 * aggregators (openrouter / deepseek / groq / xai / togetherai / fireworks /
 * deepinfra / opencode / …) and the local engines (ollama / lmstudio / …) —
 * lives on its OWN host and MUST carry an explicit base URL. The renderer
 * resolver fills that base URL from the provider catalog before each turn; this
 * set is the sidecar's last-line check that the value actually arrived.
 */
export const OPENAI_HOST_PROVIDERS = Object.freeze(new Set(["openai", "codex"]))

/**
 * True when dispatching the (already openai-protocol) built-in provider
 * `providerId` against `baseURL` would WRONGLY reach OpenAI. The base URL was
 * dropped somewhere upstream (stale renderer build, a base-URL-less custom row
 * shadowing a built-in id, a config round-trip that lost it), so the openai
 * client would fall back to `api.openai.com` and SEND THIS PROVIDER'S KEY (e.g.
 * an `sk-or-…` OpenRouter key) TO OPENAI — a credential leak that surfaces as a
 * misleading "Incorrect API key" error. Drift-free: it needs no per-provider
 * base-URL table, only the protocol map and the `*.openai.com` host check.
 *
 * Returns false for genuine OpenAI / Codex (their host IS openai), for non-
 * openai protocols, and for unknown/custom ids (which carry their own protocol
 * + base URL and are the user's responsibility).
 */
export function isMisroutedToOpenAi(providerId, baseURL) {
  if (!providerId || OPENAI_HOST_PROVIDERS.has(providerId)) return false
  if (resolveProviderProtocol(providerId) !== "openai") return false
  return isGenuineOpenAiEndpoint(baseURL)
}

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
 * True when an openai-protocol turn talks to an OpenAI-NATIVE surface: genuine
 * `*.openai.com`, the Codex ChatGPT backend, or a responses-only provider id
 * (codex, whose preset base URL may be an arbitrary relay host). These accept
 * OpenAI's proprietary reasoning fields (`reasoning_effort`, `reasoning.summary`,
 * `include: ["reasoning.encrypted_content"]`, `store`).
 *
 * The OpenAI-*compatible* gateways this protocol also serves (DeepSeek / Groq /
 * OpenRouter / Ollama / …) implement their own reasoning and may 400 on an
 * unknown field, so they must stay out — which is why this is an allowlist of
 * native surfaces rather than a "not a gateway" check.
 */
export function isOpenAiNativeSurface({ providerId, baseURL } = {}) {
  if (providerId && RESPONSES_ONLY_PROVIDERS.has(providerId)) return true
  if (isResponsesOnlyEndpoint(baseURL)) return true
  return isGenuineOpenAiEndpoint(baseURL)
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
