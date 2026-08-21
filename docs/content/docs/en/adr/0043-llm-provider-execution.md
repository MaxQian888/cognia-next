---
title: ADR-0043 — LLM provider execution & local-provider support
description: "Closes the gap between Cognia's large LLM-provider configuration surface and its actual send path. Establishes the provider resolver as the single authority on AI SDK protocol, gives built-in local engines (Ollama, LM Studio, llama.cpp, vLLM, …) a working OpenAI-compatible default endpoint, and threads each provider's configured inference parameters through the sidecar's ai-sdk dispatcher instead of dropping them. Documents the phased roadmap for tool-calling parity, multi-key rotation, real routing telemetry, and local embeddings."
---

# ADR-0043 — LLM provider execution & local-provider support

> Protocol-aware advisory benchmarks are defined by [ADR-0104 — Provider diagnostics control plane](/docs/en/adr/0104-provider-diagnostics-control-plane).

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

### Phase 6 — Unbounded agentic loop on the ai-sdk path (Accepted, implemented)

Phase 2 passed a single `stopWhen` step cap to `streamText`. For interactive turns `maxTurns` is unset, so that cap defaulted to **16 steps** — a single leg — and any task needing more tool calls ended silently when the leg cap halted the loop. The Anthropic path has no such limit (the Agent SDK loops until the model is done), so the two channels were badly asymmetric and the non-Anthropic channel "stopped on its own after a while". `dispatchAiSdk` now runs the AI SDK-blessed _manual agent loop_ (`if (finishReason === "tool-calls") continue; else break`): each leg streams a 16-step chunk, and a leg that halts on `tool-calls` continues automatically — re-streaming the accumulated conversation and running auto-compaction **between legs** so a long loop can't overflow context — until the model naturally stops or a per-turn budget is spent. The budget `maxStepsBudget` is `maxTurns` (subagents / `/goal`) ▸ the new `aiSdkMaxSteps` config (default 256) ▸ 256; reaching it while tools are still pending appends a visible "send another message to continue" note rather than stopping silently. The capture-side idle watchdog (`lib/claude/run-and-capture.ts`) was aligned in the same pass: it now pauses while a tool is executing (a long local tool is not a provider stall) and re-arms the instant a tool returns or a permission/review decision is dispatched.

### Phase 7 — Per-tool execution deadline for read-only built-ins (Accepted, implemented)

Phase 6's idle-watchdog pause has a sharp edge: if a tool's `execute` never resolves, the watchdog stays paused and the turn only dies at the 5-minute **wall-clock** (`session … did not end within 300000ms`). On the ai-sdk path this bites the read-only file tools — `content_search`, `file_search`, `glob`, `grep`, `read`, the git read tools, `lsp_*` — which walk the workspace with no internal deadline, so a huge / cyclic tree makes the handler hang and the whole session times out. Plugin tools already had a 120 s safety net (`awaitPluginToolResponse`); built-in tools on this path had none.

`dispatch/ai-sdk-tools.mjs` now bounds each read-only built-in handler (`runBuiltinHandler`): the handler races a deadline, and on timeout `execute` rejects so the AI SDK surfaces a recoverable `tool-error`. The event-adapter projects that as an errored `tool_result`, which clears the in-flight set and **re-arms the idle watchdog**, so the turn keeps moving instead of stalling to the wall-clock. Exec tools (`bash` / shell / process / git-run) self-bound with their own timeout and are deliberately **excluded** (the discriminator is `READ_ONLY_TOOL_NAMES`) — a blanket net could sever a legitimately long command. The deadline is `sendOptions.toolExecutionTimeoutMs` ▸ the bridge default (120 000 ms); the CLI sources it from the `toolExecutionTimeoutMs` config (default 120 000, `0` disables), injected by `session-runner` / `subagent-runner` exactly like `aiSdkMaxSteps`.

### Phase 8 — Inbound gateway hardening (Accepted, implemented)

The M3 inbound gateway (`src-tauri/src/gateway/`) exposes the configured providers as a local OpenAI/Anthropic-compatible endpoint. Its first cut carried a single bearer token, no upstream timeout, a hard-coded failover status set, an in-memory 25-entry request ring, and non-persisted config (so `port`/allowlist/rate-limit reset every restart and the "auto-start when `enabled`" boot path never fired). Studying newapi / one-api shaped a hardening pass that keeps the loopback-first security posture while adding the customization those gateways are known for:

- **Config persistence.** `GatewayConfig` is mirrored to `<app_data>/cognia/gateway-config.json` and hydrated in the Tauri setup hook before the auto-start check, so the listener genuinely resumes across restarts. Request-time fields (timeouts, retry policy, model exposure) live in an `Arc<RwLock<GatewayConfig>>` the running server reads per request — they apply without a restart; bind-time fields (port, bind interface, allowlist, connect timeout, global rate limit) are snapshotted at `start`.
- **Multiple scoped API keys** (`gateway/api_keys.rs`). The single token becomes a keyring-backed list of `GatewayApiKey { name, secret, modelAllowlist, expiresAt, enabled, rateLimitPerMin, lastUsedAt }` — the newapi "Tokens" model. Auth matches any usable key in constant time; the matched key's model allowlist and per-key rate limit are enforced per request. A legacy single token migrates to a "Default" key on first load. Keys never leave Rust except on explicit reveal; lists are redacted to a fingerprint.
- **Timeout + retry policy.** A `connectTimeoutSecs` bounds hung connects on every request (streaming included); a `requestTimeoutSecs` caps non-streaming requests only (streams are never total-capped). `maxRetries` bounds the candidate walk and `retryStatusCodes` replaces the hard-coded `429|408|5xx` set.
- **Model exposure.** An `exposedModels` allowlist and `hideRawProviderModels` toggle filter both `/v1/models` and request resolution; combined with the per-key allowlist this gives two independent gates (what the gateway serves at all vs. what a given key may call).
- **LAN binding** (opt-in). `bindInterface: "loopback" | "lan"` binds `0.0.0.0` and relaxes the loopback Host check for LAN peers, while keeping the cross-origin (Origin/Referer) rejection, the IPv4 allowlist (still loopback-only by default — so flipping to LAN alone exposes nothing), and key auth. DNS-rebinding via a browser stays blocked by the unchanged Origin rejection.
- **Durable request log** (Dexie **v99** `gatewayRequestLog`). The gateway emits one consolidated `gateway://request-log` event per request (success, upstream failure, or middleware rejection); `GatewayProvider` persists it to a capped table the Settings "Logs" view reads via a live query with outcome/model filters and usage tiles — the newapi Logs page. `gateway://request-outcome` still feeds the shared health/breaker/cost telemetry unchanged.

## Consequences

- Built-in local providers (Ollama, LM Studio, llama.cpp, vLLM, LocalAI, Jan, …) now actually run a chat turn, and the long-broken `xai`/`togetherai`/`fireworks` aggregators dispatch too.
- Multi-tool tasks on non-Anthropic providers run to completion instead of silently stopping after ~16 steps; the per-turn step budget is configurable (`aiSdkMaxSteps`, default 256) and a runaway loop surfaces a visible cap note rather than ending without explanation.
- A read-only built-in tool that hangs on a large workspace (`content_search` et al.) now fails as a recoverable `tool-error` after `toolExecutionTimeoutMs` (default 120 s) instead of stalling the whole session until the 5-minute wall-clock; exec tools keep their own (longer) timeouts.
- A user's configured sampling settings finally affect non-Anthropic turns.
- The resolver is the one place that decides protocol + endpoint + params; the sidecar trusts it. Adding a new OpenAI-compatible provider is now a catalog/resolver concern, not a sidecar dispatch-table edit.
- The `anthropic` vs `ai-sdk` execution fork remains: the main agent loop (MCP, permissions, A2UI, computer-use) still lives only in the Claude Agent SDK path. Phase 2 narrows — but does not erase — that gap. Mature single-path designs (Cherry Studio, LobeChat, LibreChat) avoid the fork by routing every provider through one tool-capable client; Cognia's fork is a deliberate consequence of binding the primary loop to the Claude Agent SDK.

### Phase 9 — Gateway-local policy V2 routing (Accepted, implemented)

Gateway requests now resolve through the Rust `RoutePlanner` from a validated, versioned policy snapshot. Explicit aliases own their `priority`, `weighted`, or `round-robin` distribution; the virtual `auto` model applies the configured built-in strategy after capability, availability, protocol, context, mapping-condition, and cooldown filters. OpenAI and Anthropic remain the only executable wire protocols. Other providers stay visible in configuration but cannot enter an executable walk.

Deployment rotation and credential rotation are separate reservations. Deployment cursors are scoped to the policy revision, route, and eligible-candidate fingerprint; credential cursors are scoped to the deployment and credential-pool fingerprint. Pool changes reset selection safely, duplicate/blank keys are removed, and an all-cooling pool fails with `503` plus `Retry-After`. Authentication errors do not switch credentials or providers unless a verified route ticket explicitly permits auth failover.

Retries remain pre-response-byte only. The candidate walk is bounded by both Gateway retry configuration and policy fallback limits, and its capped exponential waits share one total wait budget while respecting upstream recovery headers. Snapshot compilation remains outside the request path, and invalid V2 snapshots retain the previous valid snapshot rather than falling through to an unfiltered chain.

### Phase 10 — Difficulty signals and the second-opinion judge (Accepted, implemented)

Auto routing scored difficulty from the prompt text alone. Every other signal it
needed was already on the request and simply never read: `attachmentKinds` on the
task hints, `messageCount` on the routing context, tool availability computed one
line away as a hard capability filter, and the effort level the user had
explicitly chosen discarded entirely. A screenshot plus a twenty-turn thread was
scored as if it were the same sentence typed cold.

`deterministicDifficulty` reads all of them and reports each contribution
separately, so a threshold can be tuned from evidence rather than taste. The
text-only `scoreDifficulty` is unchanged and exact — four callers depend on it,
and a test pins the two to the same number. Effort is a **floor**, not a term:
someone who picked `max` already answered "how hard is this?", and a floor
respects that answer without capping evidence pointing higher.

On top sits an optional judge, and the interesting part is when it is **not**
consulted. The deterministic pass always runs and always yields a usable tier;
the judge is asked only when the score sits within `uncertaintyBand` of a tier
cut point. An unambiguous prompt never reaches it, so the median request gains
0 ms — which is why the two published latency figures for LLM routing (~400 ms
for a judge, tens of milliseconds for an always-on classifier) are not in
conflict: they describe two different layers.

It is fail-open in the only direction that matters. Timeout, PII refusal,
malformed answer, a judge that throws — all leave the deterministic tier exactly
where it was, so the layer can only improve a decision the router was already
unsure of. It never sends a prompt the redaction gate objects to (a routing hint
is not worth a disclosure), and it never caches a timeout (that would turn one
slow moment into five minutes of a disabled judge). A verdict that moves the tier
moves the score with it, because the alias ladder is chosen from the score —
recording a verdict and then ignoring it would be worse than not asking.

The package stays free of any LLM dependency: `judgeDifficulty` is injected
through the same runtime seam as pricing and capabilities, and the gate is read
from the runtime adapters when a request does not carry its own — so a caller
that never heard of the feature still honours the user's switch. Off by default
twice over: `autoRouting.judge.enabled` does nothing unless `autoRouting.enabled`
is also on, and shadow mode remains the intended rollout path.

`routing.plan` attributes are now built in one place. Both emit sites hand-wrote
them and had already drifted — the teammate dispatcher omitted the classification
entirely, so every teammate turn contributed a decision id with no score and
calibration counted it as absent. Numbers and enums only: the calibration
pipeline reads decisions and never content, and a trace attribute carrying prompt
text would break that on a path that runs for every routed turn.
`analyzeRoutingCalibration` also reports how the judge behaved — consulted,
agreed, overrode, mean latency — because whether a second-opinion layer earns its
cost is an empirical question, not an architectural one.
