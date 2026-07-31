# Claude Agent SDK through Cognia's gateway to non-Claude models

Date: 2026-07-23  
Scope: current repository, bundled `@anthropic-ai/claude-agent-sdk` 0.3.183 / Claude Code 2.1.183, and current first-party Anthropic and AI SDK documentation.

## Executive conclusion

The answer has two different meanings:

1. **Can it be made to run? Yes, for a limited compatibility envelope.** The Agent SDK accepts an `env` map for its Claude Code subprocess. Pointing `ANTHROPIC_BASE_URL` at Cognia and supplying a Cognia gateway credential makes the subprocess call Cognia's `/v1/messages`. Cognia can translate the basic Anthropic Messages request, tool-call loop, and SSE response to and from an OpenAI-compatible upstream. The repository even labels this stream direction as the “Claude-Code-CLI-on-any-provider path.”
2. **Is this a supported, semantically complete way to run non-Claude models in Claude Agent SDK? No.** Anthropic now states this boundary explicitly: it “doesn't support routing Claude Code to non-Claude models through any gateway.” Cognia's gateway also does not currently implement the full, evolving Claude Code gateway contract. It is sufficient for basic text and client-tool experiments, not a product-grade substitute for Cognia's provider-neutral AI SDK agent runtime.

The built-in gateway is a reasonable **inbound interoperability and routing gateway**. Its security gates, scoped keys, model exposure, candidate failover, key cooldown, concurrency accounting, and stream translation are coherent for that purpose. It is not currently a reasonable **canonical non-Claude Agent SDK backend**, and it cannot solve headless/browser agent execution because the current gateway surface is explicitly desktop-only.

Recommended product boundary:

- Claude models through Anthropic, Bedrock, Claude Platform on AWS, Google Cloud's Agent Platform, Microsoft Foundry, or a gateway preserving the appropriate Claude protocol: **supported Agent SDK path**.
- Non-Claude models through Cognia's gateway into Claude Agent SDK: **experimental compatibility mode only**.
- Non-Claude models in production: **Cognia's AI SDK agent runtime**, with the runtime extracted from the desktop sidecar so Node/headless and capability-limited browser hosts can reuse it.

## What the current execution path actually does

### The SDK path is selected by provider ID, not protocol

`sidecar/dispatch/index.mjs:23-28` sends only `provider === "anthropic"` to `dispatchAnthropic`; every other provider goes to `dispatchAiSdk`. A custom provider whose protocol is `"anthropic"` still goes through the AI SDK path if its provider ID is not literally `"anthropic"`.

The Anthropic dispatcher then:

- overlays per-turn account and proxy variables onto the host environment (`sidecar/dispatch/anthropic.mjs:292-309`);
- adds selected headers through `ANTHROPIC_DEFAULT_HEADERS` (`sidecar/dispatch/anthropic.mjs:311-329`);
- passes the requested model and environment into `query()` (`sidecar/dispatch/anthropic.mjs:339-380`, `:556`);
- launches the bundled Claude Code process indirectly through the SDK, rather than issuing Messages API calls itself.

The bundled package is Agent SDK 0.3.183 and embeds Claude Code 2.1.183 (`sidecar/node_modules/@anthropic-ai/claude-agent-sdk/package.json:1-5`, `:83`). Its public types describe `env` as the complete Claude Code subprocess environment and warn that it replaces, rather than merges with, `process.env` (`sdk.d.ts:1348-1365`). Cognia correctly compensates with `{ ...process.env, ...sendOptions.env }`. Its `model` field is an arbitrary TypeScript `string`, although the contract calls it a “Claude model” (`sdk.d.ts:1621-1625`).

This agrees with Anthropic's current documentation: the Agent SDK has no gateway-specific API. It starts Claude Code and passes environment variables to that subprocess. For TypeScript, callers must spread `process.env` themselves when setting `options.env`. See [Connect Claude Code to an LLM gateway](https://code.claude.com/docs/en/llm-gateway-connect#agent-sdk).

### The built-in gateway deliberately exposes a Claude Code route

The gateway crate describes itself as a local OpenAI- and Anthropic-compatible service for external tools including Claude Code (`crates/cognia-gateway/src/lib.rs:1-18`). The settings UI already emits `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` (`components/settings/gateway/gateway-section.tsx:263-284`).

Its protected routes include:

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/messages`
- `POST /v1/embeddings`
- `POST /v1/responses`

See `crates/cognia-gateway/src/server.rs:218-233`.

`POST /v1/messages` and `POST /v1/chat/completions` enter the same `handle_chat` function with different inbound-format tags (`server.rs:659-675`, `:1489-1554`). Candidate selection can resolve an alias, a `provider:model` literal, or a uniquely owned raw model, but only providers whose protocol is `"openai"` or `"anthropic"` are executable (`crates/cognia-gateway/src/execute.rs:147-197`).

For an Anthropic-format inbound request routed to an OpenAI-format provider, the gateway:

1. parses the Anthropic body into `ChatIR`;
2. renders an OpenAI Chat Completions body;
3. sends it to the selected upstream;
4. translates either the buffered response or streaming SSE back into Anthropic Messages format.

See `server.rs:1569-1653`, `:1724-1747`, `:1754-1874`, and `:1877-1982`.

This is not accidental. `crates/cognia-gateway/src/translate/stream.rs:7-15` names `OpenAiToAnthropic` as the “Claude-Code-CLI-on-any-provider path.”

### A basic real-SDK round trip is proven locally

The repository's live harness starts the real sidecar, real Agent SDK, and bundled Claude Code against a minimal Anthropic Messages mock using `ANTHROPIC_BASE_URL` (`sidecar/dispatch/live-harness.mjs:1-8`, `:77-100`, `:124-145`). It explicitly notes that Claude Code can make auxiliary `/v1/messages` calls (`:67-75`).

On 2026-07-23, this focused verification passed:

```text
✔ anthropic dispatch streams a real assistant reply + success result
✔ anthropic dispatch reports a session id for the turn
```

Command: `cd sidecar && node --test dispatch/anthropic.live.test.mjs`.

This proves the base-URL transport seam and a minimal Anthropic SSE envelope. It does **not** test Cognia's gateway translator against a real non-Claude upstream, tool calls, beta features, retries, or long-running sessions.

## Official support boundary

Anthropic's supported Agent SDK authentication/deployment surfaces are Anthropic's API plus Claude on Amazon Bedrock, Claude Platform on AWS, Google Cloud's Agent Platform, and Microsoft Foundry. The Agent SDK overview lists those provider modes and environment variables; they are alternate hosting paths for **Claude**, not a model-agnostic contract. See [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview#get-started).

Anthropic's current gateway documentation is unambiguous:

> Anthropic ... doesn't support routing Claude Code to non-Claude models through any gateway.

See [Other LLM gateways](https://code.claude.com/docs/en/llm-gateway), especially lines 94-113 in the published page.

Therefore:

- an Anthropic-format proxy in front of Claude is within the documented gateway model;
- an Anthropic-format translator in front of GPT, Gemini, DeepSeek, GLM, Qwen, or another non-Claude model may work technically, but it is outside Anthropic's support contract;
- accepting any model string does not expand the supported model set. Behind a custom `ANTHROPIC_BASE_URL`, Claude Code passes model strings through because the gateway owns naming, but this is a routing behavior, not a guarantee that a non-Claude model implements Claude semantics. See [Model configuration](https://code.claude.com/docs/en/model-config#setting-your-model), particularly the model validation rules around lines 167-173.

## Contract comparison: Claude Code versus Cognia gateway

Anthropic's first-party [Gateway protocol reference](https://code.claude.com/docs/en/llm-gateway-protocol) is the controlling protocol source. It says the Anthropic Messages gateway surface consists of `/v1/messages`, optional `/v1/messages/count_tokens`, realtime SSE, open-ended `anthropic-beta` and `anthropic-version` forwarding, feature/body pairing, original upstream error bodies, and optional model discovery.

| Contract area                      | Cognia today                                                                                                                                                                                                                                           | Assessment for non-Claude Agent SDK                                                                                                                                                                                                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base URL and inference route       | `POST /v1/messages` exists (`server.rs:218-225`). Axum matches the path even when Claude Code sends `?beta=true`.                                                                                                                                      | Basic transport is viable.                                                                                                                                                                                                                                                                                                                      |
| Token counting                     | No `/v1/messages/count_tokens` route is registered.                                                                                                                                                                                                    | Allowed by the official contract; Claude Code estimates locally. Less accurate context budgeting, but not a hard blocker.                                                                                                                                                                                                                       |
| Startup traffic                    | `/healthz` exists, but there is no explicit `HEAD /`; the root route will normally return 404.                                                                                                                                                         | Officially best-effort and rejectable, so not a hard blocker.                                                                                                                                                                                                                                                                                   |
| Client authentication              | Middleware accepts either `Authorization: Bearer` or `x-api-key` (`server.rs:429-440`, `:504-528`).                                                                                                                                                    | Compatible with `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` gateway credentials.                                                                                                                                                                                                                                                             |
| Host/origin security               | Loopback Host validation, IP allowlist, and browser `Origin`/`Referer` rejection are enforced (`server.rs:416-503`).                                                                                                                                   | Reasonable for a local desktop gateway.                                                                                                                                                                                                                                                                                                         |
| Model routing                      | Aliases, `provider:model`, raw models, exposure filters, per-key allowlists, and executable-protocol filtering are implemented (`execute.rs:147-219`; `server.rs:587-652`).                                                                            | Good routing foundation.                                                                                                                                                                                                                                                                                                                        |
| Model discovery shape              | Returns OpenAI-style `{object:"list",data:[{id,...}]}` (`server.rs:587-652`).                                                                                                                                                                          | Shape is accepted, but Claude Code ignores discovered IDs not beginning with `claude` or `anthropic`. Non-Claude names require manual model configuration or Claude-prefixed aliases. The official filter is documented at [Gateway protocol reference: model discovery](https://code.claude.com/docs/en/llm-gateway-protocol#model-discovery). |
| Inbound headers                    | The handler receives only parsed JSON plus request context. It does not carry inbound `anthropic-beta`, `anthropic-version`, `anthropic-*`, or `x-claude-code-*` headers into upstream execution (`server.rs:443-582`, `:669-675`, `:1489-1653`).      | Major contract gap. Session/agent attribution is lost, and same-format Anthropic passthrough still strips evolving capability headers.                                                                                                                                                                                                          |
| Anthropic upstream headers         | The gateway synthesizes only `content-type`, `x-api-key`, and fixed `anthropic-version: 2023-06-01` (`execute.rs:240-256`).                                                                                                                            | Violates the open-list forwarding rule and cannot preserve OAuth capability betas or feature betas.                                                                                                                                                                                                                                             |
| Same-format body passthrough       | Rewrites `model`, then applies configured field stripping (`server.rs:1620-1641`).                                                                                                                                                                     | Mostly useful, but not byte-for-byte. Configured stripping can break header/body feature pairs.                                                                                                                                                                                                                                                 |
| Cross-format request body          | `ChatIR` preserves basic system text, user/assistant text, images, client tools, tool choice, tool calls/results, max tokens, sampling values, and stops (`translate/anthropic.rs:55-166`, `:182-270`; `translate/openai.rs:240-370`).                 | Sufficient for a conventional client-tool loop.                                                                                                                                                                                                                                                                                                 |
| System blocks and cache control    | Anthropic system arrays are concatenated into one string; text-block metadata is not preserved (`translate/anthropic.rs:68-82`; OpenAI output at `translate/openai.rs:243-246`).                                                                       | Breaks Claude Code's positional attribution block and loses cache-control metadata. Anthropic says gateways that reshape the system array should disable the attribution header.                                                                                                                                                                |
| Extended thinking                  | `thinking` and `redacted_thinking` blocks are deliberately dropped on cross-protocol hops (`translate/anthropic.rs:150-152`, `:287-289`). Request-side `thinking`, signatures, and interleaved-thinking semantics are not represented in `ChatIR`.     | Major semantic loss. Long sessions and tool turns can fail when Claude Code expects thinking/signature continuity.                                                                                                                                                                                                                              |
| New/beta request fields            | The IR is a closed schema. Fields such as `context_management`, beta tool properties (`strict`, `defer_loading`), `output_config`, prompt caching metadata, and future fields are not represented.                                                     | Major forward-compatibility gap. The official contract explicitly says these lists evolve and paired fields/headers must move together.                                                                                                                                                                                                         |
| Client tool definitions            | `name`, `description`, and `input_schema` map to OpenAI function tools (`translate/anthropic.rs:92-112`; `translate/openai.rs:342-370`).                                                                                                               | Core tools can work if the upstream model reliably supports native tool calling and JSON arguments.                                                                                                                                                                                                                                             |
| Tool calls and results             | Anthropic `tool_use` maps to OpenAI `tool_calls`; Anthropic user `tool_result` maps to OpenAI `role:"tool"` (`translate/anthropic.rs:137-146`; `translate/openai.rs:165-205`, `:247-337`).                                                             | Correct basic structural mapping. Rich tool-result arrays are flattened to text; tool-result images/documents/search results and some error semantics are lost.                                                                                                                                                                                 |
| Streaming text and tools           | OpenAI deltas become Anthropic `message_start`, content-block start/delta/stop, `message_delta`, and `message_stop`; fragmented arguments become `input_json_delta` (`translate/stream.rs:119-302`).                                                   | Strongest part of the compatibility layer; adequate for text and ordinary function calls.                                                                                                                                                                                                                                                       |
| Streaming errors and future events | SSE `event:` names are discarded by the deframer (`execute.rs:259-270`). The OpenAI-to-Anthropic translator only handles choices, text, tool calls, finish reason, and usage; unrecognized/error payloads are ignored (`translate/stream.rs:203-302`). | A mid-stream error can be swallowed and followed by a synthesized normal terminal envelope. This is unsafe for a production Agent SDK path.                                                                                                                                                                                                     |
| Non-stream errors                  | The gateway preserves the HTTP status in many cases but wraps the upstream body in its own `HTTP <status>: ...` message and native error envelope (`server.rs:1674-1721`; `translate/errors.rs:46-56`).                                                | Violates Anthropic's requirement to forward error response bodies unchanged. Claude Code's capability fallback/retry logic matches error wording, so automatic recovery can break.                                                                                                                                                              |
| Same-format streaming              | Same-protocol upstream bytes are forwarded unchanged while usage is sniffed (`server.rs:1891-1971`).                                                                                                                                                   | Good byte preservation for the body, but inbound capability headers were already lost before the request.                                                                                                                                                                                                                                       |
| Capability declaration             | No Agent-SDK-specific capability negotiation exists. Anthropic documents that `ANTHROPIC_DEFAULT_*_MODEL_SUPPORTED_CAPABILITIES` has no effect behind `ANTHROPIC_BASE_URL`.                                                                            | Claude Code may infer current-Claude features for an alias and send unsupported fields to a non-Claude model path.                                                                                                                                                                                                                              |

## Why basic tool use can work but “Claude Agent SDK semantics” still do not transfer

The core client-tool exchange is portable:

1. Claude-format request defines tools using `name`, `description`, and `input_schema`.
2. An OpenAI-compatible model returns a function/tool call.
3. Cognia converts it into an Anthropic `tool_use` block and `stop_reason: "tool_use"`.
4. Claude Code executes the local/MCP tool.
5. Its next request contains a user `tool_result`.
6. Cognia converts that into `role:"tool"` for the upstream.

The official Claude tool contract confirms that client calls use assistant `tool_use` blocks and user `tool_result` blocks. See [Tool use with Claude](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview) and [Handle tool calls](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls).

However, Claude Agent SDK is more than this minimal loop. Claude Code continually adds Claude-specific request fields, beta headers, reasoning behavior, context management, prompt caching, server tools, subagent behavior, fallback rules, and error-recovery heuristics. Anthropic's gateway reference explicitly warns that gateways must treat headers and body fields as open lists, preserve header/body feature pairs, stream in realtime, and forward upstream errors unchanged. Cognia's cross-protocol IR necessarily collapses that open protocol into a closed lowest-common-denominator schema.

The result is an important distinction:

- **Harness portability:** Claude Code's local tools, MCP processes, permissions, hooks, transcript handling, and subprocess lifecycle may continue operating around another model.
- **Model/protocol portability:** the other model does not acquire Claude's tool reliability, reasoning signatures, context semantics, server-side tools, safety/fallback behavior, or future protocol features merely because its responses are wrapped as Anthropic Messages.

## Design assessment

### What is reasonable today

The gateway is well designed for its stated ADR-0043 role:

- it keeps secrets in Rust/keyring-side state and accepts scoped client keys;
- it defaults to loopback, rejects browser-origin traffic, validates hosts, and supports explicit LAN allowlists;
- it uses the same renderer routing decisions, model exposure controls, failover candidates, account pools, cooldowns, and telemetry as the app;
- it holds concurrency slots through streaming completion;
- it cleanly separates inbound format, canonical IR, upstream protocol, and SSE translation;
- it preserves same-format streaming bytes.

These are appropriate choices for exposing Cognia's configured providers to ordinary OpenAI/Anthropic clients.

### What is not reasonable as a stable architecture

Using this gateway to make every model enter the Claude Agent SDK would create a compatibility dependency on a private, rapidly evolving Claude Code protocol surface. The current implementation already contradicts several newly documented gateway requirements:

- beta/version/open-list headers are not forwarded;
- error bodies are rewritten;
- system arrays and metadata are reshaped;
- thinking and many feature fields are dropped;
- stream errors are not projected correctly;
- non-Claude model discovery is filtered by Claude Code;
- the upstream translator only supports OpenAI Chat Completions and Anthropic Messages, not the full provider set that Cognia's AI SDK adapters support.

It would also make provider selection misleading: the code dispatches by provider ID, so a non-Claude turn would need to masquerade as `provider: "anthropic"` while its model alias routes elsewhere through the gateway. Provider-level pricing, capability decisions, fallback models, and telemetry could then disagree between the renderer, sidecar, Claude Code, and gateway.

Finally, this cannot be the answer to “agent without desktop.” `types/gateway/index.ts:1-7` explicitly says the gateway is desktop-only because the HTTP listener is provided by the Tauri shell. The gateway also depends on a routing snapshot published by the renderer; without one, it returns a 503 asking the user to open Cognia once (`server.rs:1489-1502`). The Rust crate could be extracted into a headless service later, but that is not the current runtime topology.

## Practical feasibility test

A lab configuration is conceptually possible:

```text
Claude Agent SDK query()
  env.ANTHROPIC_BASE_URL = http://127.0.0.1:47823
  env.ANTHROPIC_API_KEY = <Cognia gateway key>
  options.model = <gateway alias>
             |
             v
Cognia POST /v1/messages
             |
             v
OpenAI-compatible non-Claude provider
```

Conditions:

1. The gateway is running and has a fresh routing snapshot.
2. The gateway key allows the alias.
3. The turn is dispatched through Cognia's Anthropic dispatcher, which currently means the provider ID must be `"anthropic"` or the dispatch policy must gain an explicit runtime override.
4. The alias resolves to an executable `"openai"` or `"anthropic"` provider.
5. The non-Claude upstream supports streaming Chat Completions and native tool calls sufficiently well.
6. Experimental Claude Code fields are disabled or stripped **together with their paired headers**, and adaptive thinking is handled separately.
7. The test scope accepts missing thinking, cache metadata, rich tool results, exact error recovery, and other Claude-only features.

Even with those conditions, this is “works for the tested version and feature subset,” not an API guarantee.

## Recommended decision

### Product decision

Do not change the primary architecture to:

```text
all models -> Claude Agent SDK -> Cognia gateway
```

Keep:

```text
Claude -> Claude Agent SDK adapter
non-Claude -> Cognia AI SDK agent adapter
external agents -> external-agent adapters
```

and extract the AI SDK runtime from `claude-host` into a provider-neutral Agent Runtime package. The AI SDK's official `ToolLoopAgent` contract is explicitly model-provider based and implements multi-step tool loops around a `LanguageModel`; it is the supported abstraction shape for provider-neutral agents. See [AI SDK `ToolLoopAgent`](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent) and [AI SDK agents overview](https://ai-sdk.dev/docs/agents/overview). Cognia may keep its current manual loop initially to preserve its extra compaction, approval, plugin, and telemetry semantics.

### If Cognia keeps the gateway experiment

Label it experimental and add a conformance suite driven by the real bundled Claude Code version. At minimum:

1. propagate inbound `anthropic-*` and `x-claude-code-*` headers, or explicitly consume them with documented behavior;
2. preserve same-format error bodies and headers unchanged;
3. translate mid-stream errors to Anthropic `event:error`;
4. add fixtures for parallel tools, fragmented/invalid JSON, tool errors, rich tool results, long histories, subagents, resume, steering, 400 capability retries, 429/529, and stream stalls;
5. explicitly gate unsupported request features instead of silently dropping them;
6. disable the attribution header when reshaping `system`;
7. test each bundled SDK/Claude Code upgrade against the official gateway protocol;
8. use Claude-prefixed gateway aliases only as a picker workaround, never as a claim that the routed model is Claude;
9. expose the actual upstream provider/model in telemetry and UI so routing is not disguised;
10. keep the AI SDK path as the fallback and the production default for non-Claude models.

## Primary sources

- Repository:
  - `sidecar/dispatch/index.mjs`
  - `sidecar/dispatch/anthropic.mjs`
  - `sidecar/dispatch/live-harness.mjs`
  - `sidecar/dispatch/anthropic.live.test.mjs`
  - `sidecar/node_modules/@anthropic-ai/claude-agent-sdk/package.json`
  - `sidecar/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
  - `crates/cognia-gateway/src/{lib,server,execute,snapshot}.rs`
  - `crates/cognia-gateway/src/translate/{anthropic,openai,stream,errors}.rs`
  - `types/gateway/index.ts`
  - `components/settings/gateway/gateway-section.tsx`
- Anthropic:
  - [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
  - [Hosting the Agent SDK](https://code.claude.com/docs/en/agent-sdk/hosting)
  - [Other LLM gateways](https://code.claude.com/docs/en/llm-gateway)
  - [Gateway protocol reference](https://code.claude.com/docs/en/llm-gateway-protocol)
  - [Connect Claude Code to an LLM gateway](https://code.claude.com/docs/en/llm-gateway-connect)
  - [Model configuration](https://code.claude.com/docs/en/model-config)
  - [Streaming Messages](https://platform.claude.com/docs/en/build-with-claude/streaming)
  - [Tool use with Claude](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview)
  - [Handle tool calls](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)
- AI SDK:
  - [Agents overview](https://ai-sdk.dev/docs/agents/overview)
  - [`ToolLoopAgent`](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent)
