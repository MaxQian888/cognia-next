---
title: ADR-0043 — LLM provider execution & local-provider support
description: "Closes the gap between Cognia's large LLM-provider configuration surface and its actual send path. Establishes the provider resolver as the single authority on AI SDK protocol, gives built-in local engines (Ollama, LM Studio, llama.cpp, vLLM, …) a working OpenAI-compatible default endpoint, and threads each provider's configured inference parameters through the sidecar's ai-sdk dispatcher instead of dropping them. Documents the phased roadmap for tool-calling parity, multi-key rotation, real routing telemetry, and local embeddings."
---

# ADR-0043 — LLM provider execution & local-provider support

**Status**: Accepted (design); implemented incrementally — verify per-phase against the code. On `feat/unified-plan-execution-hub`, the **non-Anthropic dispatcher** work — gated tool-calling (Phase 2), AI SDK v6 field mapping (`text` / `output` / `tool-error`), built-in local-engine protocol resolution, and `modelParams` forwarding — was recovered from the `qc-stash-backup` snapshot and landed during the built-in-agent P0 wave (2026-06-03). The remaining send-path wiring for **Phase 3 (multi-key rotation)** and **Phase 4 (routing telemetry)** is **not yet on this branch**: the types/UI exist, but `selectApiKey` / `recordProviderOutcome` are not yet called from `build-options` / `use-claude-chat` here — deferred to the provider-routing wave.
**Authors**: Max Qian + Claude Opus 4.8
**Builds on**: the multi-provider port (`provider`/`providerCredentials` on `SendOptions`, the `anthropic` vs `ai-sdk` dispatch split), `lib/ai/provider-consumption.ts`, the models.dev catalog sync, and the existing provider settings UI (`components/settings/provider/*`, ~50 components)
**Affects**: `lib/ai/provider-consumption.ts`, `lib/ai/providers/{inference-params,api-key-rotation,circuit-breaker-machine,health-metrics-collector,model-pricing}.ts` (new), `lib/ai/embedding/{embedding,local-embedding}.ts`, `lib/claude/{build-options,types,provider-telemetry}.ts`, `types/provider/provider.ts`, `stores/settings/{health-metrics,circuit-breaker}-store.ts`, `hooks/chat/use-claude-chat.ts`, `sidecar/dispatch/{ai-sdk,ai-sdk-tools,event-adapter,index}.mjs`, `sidecar/builtin-tools/index.mjs`

## Context

Cognia has an **unusually complete provider configuration surface**: a rich type system (`types/provider/*` — provider/model configs, 10 local engines, routing presets, circuit-breaker/load-balancer/health-metric types), a four-source model-discovery merge (static catalog → models.dev → remote `/v1/models` → user-curated), a `LocalProviderService` (status/list/pull/delete/stop/embedding with Tauri commands + HTTP fallback), and ~50 settings components (sidebar, config/models/cost/parameters/routing/health tabs, a local-provider setup wizard, an Ollama model manager, custom-provider dialogs, quick-add, import/export, comparison, batch-test).

The main chat runs through the Claude Agent SDK in the sidecar (`sidecar/dispatch/anthropic.mjs`). Any non-Anthropic provider flows through a second dispatcher, `sidecar/dispatch/ai-sdk.mjs`, which runs a turn against the AI SDK's `streamText()`. `lib/claude/build-options.ts:resolveSendOptions` resolves the selected provider into `provider` + `providerCredentials` and sends them inline so the sidecar stays credential-free.

**The configuration surface was far ahead of the execution path.** Auditing the send path end to end surfaced concrete breaks:

1. **Built-in local providers could not send a single turn.** The sidecar's `resolveProtocol` only recognised `openai/openrouter/deepseek/groq/mistral-openai-compat/google/gemini/mistral/cohere/anthropic` — none of the local engine ids (`ollama`, `lmstudio`, `llamacpp`, …). And `build-options` only forwarded `providerCredentials.protocol` **for custom providers** (`isCustomProvider ? protocol : undefined`). So selecting built-in Ollama produced `provider="ollama"` with no protocol → `resolveProtocol("ollama") === null` → `session_ended: provider "ollama" has no resolvable AI SDK protocol`. The setup wizard and Ollama model manager configured a provider that the chat could never actually call. The same `resolveProtocol`/`build-options` mismatch silently broke the OpenAI-compatible aggregators `xai` / `togetherai` / `fireworks` as well.

2. **No default endpoint for keyless local providers.** A local engine needs no API key but does need a base URL. When a user enabled Ollama via the wizard without typing one, the resolver returned `unresolved` (it requires *either* a key *or* a base URL), so the turn never dispatched.

3. **Configured inference parameters were dropped.** `ai-sdk.mjs` hard-coded `maxTokens: undefined, temperature: undefined` into every `streamText` call. The provider parameters tab (temperature, max tokens, penalties, …) was therefore decorative for every non-Anthropic provider.

## Decision

Treat the **provider resolver as the single authority** on what protocol/endpoint/params a turn runs against, and make the sidecar honour that authority instead of re-deriving or discarding it. Phase 1 lands the foundation that makes built-in local providers actually work; later phases build capability on top.

### Phase 1 — Foundation (Accepted, implemented)

- **Local base-URL default in the resolver.** `lib/ai/provider-consumption.ts:resolveOne` now falls back to the catalog default (`LOCAL_PROVIDER_URLS`, normalised to the OpenAI-compatible `/v1` surface via `getOpenAICompatibleURL`) when a built-in local provider has no explicit base URL. This runs *before* the "needs key or base URL" guard, so a keyless local engine resolves cleanly. Explicit user base URLs are never overridden. Because the resolver feeds both the chat send path and the plugin AI surface, both benefit.

- **The resolver always forwards `protocol`.** `build-options.ts` now sets `providerCredentials.protocol = resolution.protocol` unconditionally (previously custom-only). The resolver already knows every provider's family (`BUILTIN_PROTOCOLS[id] ?? "openai"`, or the custom provider's declared protocol), so this removes the fragile dependency on the sidecar re-deriving protocol from an id. The Anthropic provider continues to dispatch via `dispatchAnthropic` (selected by provider id, not protocol), so forwarding `"anthropic"` is inert there.

- **Defence-in-depth in the sidecar.** `sidecar/dispatch/ai-sdk.mjs:resolveProtocol` now maps every built-in local engine id to `"openai"`, so a turn still dispatches even if a caller forgets to set `protocol`. The explicit `providerCredentials.protocol` (now always present from `build-options`) still takes precedence.

- **Inference parameters reach the request.** A new pure helper `lib/ai/providers/inference-params.ts:buildModelInferenceParams` translates a provider's persisted `inferenceDefaults` / `connectionParams` / `advancedParams` into AI SDK v6 call-option naming (`ModelInferenceParams` in `types/provider/provider.ts` — note the v5+ rename `maxTokens → maxOutputTokens`; `topK`/`seed`/`stopSequences` ride in `advancedParams`). `build-options` attaches the result to `SendOptions.modelParams`; the sidecar spreads it into `streamText` instead of the hard-coded `undefined`s. The new field travels via the Rust `SendOptions`'s existing `#[serde(flatten)] extra` catch-all, so **no Rust struct change was required**. The Anthropic path ignores `modelParams`.

### Phase 2 — Tool/MCP for non-Anthropic providers (Accepted, implemented)

`sidecar/dispatch/ai-sdk-tools.mjs` (new) converts the built-in tool defs (shared with the Anthropic path via the new `collectCogniaToolDefs` export) and the renderer-proxied plugin tools into native AI SDK tools; `ai-sdk.mjs` passes them to `streamText` with a `stopWhen` step cap (multi-step agentic loop) and exposes `pendingPluginToolCalls` so plugin tools round-trip through the same `plugin_tool_response` channel as the Anthropic path. The event-adapter was also corrected for AI SDK v6 field names (`text` / `output` / `tool-error`) — a latent bug that had been returning empty assistant text on the real (non-fake-event) path. Tool execution is gated by the same `permission_request` round-trip as the Anthropic path — `createToolPermissionGate` mirrors `canUseTool` (suppress-list + static ruleset short-circuit, `bypassPermissions` honoured, otherwise a renderer approval resolved via the session's `pendingApprovals`), so a local model can't silently run shell/process tools. A2UI remains Anthropic-only.

### Phase 3 — Multi-API-key rotation (Accepted, implemented)

`lib/ai/providers/api-key-rotation.ts` (new) — a pure `selectApiKey` (round-robin / random / least-used over the cleaned `apiKeys[]` pool) + `recordKeyUse` (advance `currentKeyIndex`, bump per-key usage). `build-options` picks the next key, overrides the single-key credential, and persists the advance fire-and-forget (dynamic-imported settings store, off the hot path).

### Phase 4 — Real routing telemetry (Accepted, implemented)

The `health-metrics-store` + `circuit-breaker-store` stubs were replaced with real implementations of the contracts already defined in `types/provider/{health-metrics,circuit-breaker}.ts`, built on pure modules: `health-metrics-collector.ts` (sliding-window buckets → p50/p95/avg latency, success/error rates, cost, trends) and `circuit-breaker-machine.ts` (closed→open→half-open FSM with cooldown). `build-options` now feeds these stores into `ProviderRoutingEngine` deps (open breakers drop a provider from rotation; `getPricing` resolves via `model-pricing.ts`), and `lib/claude/provider-telemetry.ts` (new) records one outcome per turn from `use-claude-chat` (success on the result event, failure on `session_ended.error` before any fallback re-issues).

### Phase 5 — Local embeddings (Accepted, implemented)

`lib/ai/embedding/local-embedding.ts` (new) + a case in `getEmbeddingModel` route the OpenAI-compatible local engines (LM Studio, llama.cpp, vLLM, LocalAI, Jan) through the AI SDK openai embedding client with their `/v1` baseURL (Ollama already had a native path). The vector embedding adapter (`lib/vector/embedding.ts`) gained the local provider ids, keyless handling, and baseURL passthrough; the twin embedding settings (`twin-settings-tab` + `TwinRuntimeEmbeddingSettings`) now expose the local engines and a Base URL field, and `use-twin-worker` activates keyless providers without an API key. Any RAG / twin / memory caller that supplies a local `provider` + `baseURL` embeds locally.

## Consequences

- Built-in local providers (Ollama, LM Studio, llama.cpp, vLLM, LocalAI, Jan, …) now actually run a chat turn, and the long-broken `xai`/`togetherai`/`fireworks` aggregators dispatch too.
- A user's configured sampling settings finally affect non-Anthropic turns.
- The resolver is the one place that decides protocol + endpoint + params; the sidecar trusts it. Adding a new OpenAI-compatible provider is now a catalog/resolver concern, not a sidecar dispatch-table edit.
- The `anthropic` vs `ai-sdk` execution fork remains: the main agent loop (MCP, permissions, A2UI, computer-use) still lives only in the Claude Agent SDK path. Phase 2 narrows — but does not erase — that gap. Mature single-path designs (Cherry Studio, LobeChat, LibreChat) avoid the fork by routing every provider through one tool-capable client; Cognia's fork is a deliberate consequence of binding the primary loop to the Claude Agent SDK.
