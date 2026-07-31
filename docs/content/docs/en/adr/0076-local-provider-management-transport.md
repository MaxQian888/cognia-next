---
title: ADR-0076 — Local-provider management transport
description: "Route every local-provider management call through the Rust HTTP proxy instead of renderer fetch or bespoke Tauri commands, keep streaming pull as the single exception, and require host-injected runtime adapters for packages/provider-core."
---

# ADR-0076 — Local-provider management transport

**Status**: Accepted (2026-07-16)

## Context

Cognia ships ten local inference providers (ollama, lmstudio, llamacpp,
llamafile, vllm, localai, jan, textgenwebui, koboldcpp, tabbyapi). Their
configuration surface — inline provider entries, settings cards, bilingual
strings — was complete and correct. The management surface was not, and the
shape of the failure explains why nobody reported it.

**The architecture was asymmetric.** Chat worked; management did not:

| Path       | Runs in            | CSP        | Outcome     |
| ---------- | ------------------ | ---------- | ----------- |
| Chat send  | Node sidecar       | none       | worked      |
| Management | renderer           | enforced   | dead        |
| Embedding  | renderer → invoke  | n/a        | threw       |

Users spent their time on the path that worked and rarely touched the one that
did not, so a permanently broken surface looked healthy for months.

Three independent failures stacked, and all three had to be fixed:

1. **No Rust implementation.** `packages/provider-core/.../ollama.ts` made eight
   `invoke("ollama_*")` calls. A search for `ollama` across all 543 `.rs` files
   returned nothing — not one of those commands had ever been written. Most were
   uncaught, so the desktop app threw `Command not found` on every call.
   `local-provider-service.ts` wrapped its equivalents in `try/catch`, so
   instead of failing loudly it fell through to HTTP on every desktop run — into
   failure 2.

2. **CSP closed the fallback.** `tauri.conf.json`'s `connect-src` is
   `'self' ipc: http://ipc.localhost ws: wss:` — no `http:` scheme, and
   `tauri.macos.conf.json` adds no override. A renderer `fetch` to
   `http://localhost:11434` is blocked before leaving the WebView; loopback is
   not `'self'`. This same CSP had already silently killed the OTLP, Langfuse and
   generic `remote` log transports (ADR-0074), which shipped for months without
   emitting a byte.

3. **The hook layer was stubbed.** `useLocalProvider`'s pull/delete/stop were
   `deferred()` no-ops that only set an error string, and `useLocalProvidersScan`
   — the sole data source behind the settings Scan button — returned a frozen
   empty map and a `noopScan`.

Two things kept all of this invisible:

- **`pnpm dev` has no CSP.** Development exercised the fallback and it worked.
- **The tests certified the fantasy.** `ollama.test.ts` never simulated a Tauri
  host, so `isTauri()` was permanently false and the `invoke` branches had zero
  coverage. `local-provider-service.test.ts` was worse: it *mocked* `invoke`, so
  twelve tests asserted that commands which do not exist were called with the
  right arguments — and passed.

`packages/provider-core` already exposed `setProviderCoreRuntimeAdapters` for a
host to inject `isTauri` / `proxyFetch` / loggers. It had **zero production call
sites**, so `proxyFetch` was permanently its own `defaultProxyFetch` — a bare
`fetch`.

## Decision

- **The renderer reaches local servers through Rust, via `proxyFetch`.** All
  non-streaming management calls (status, tags, show, delete, ps, copy,
  embeddings) tunnel through the existing `proxy_http_request` command, where
  reqwest is bound by neither CSP nor CORS. Adding eight Rust commands to revive
  `invoke` would buy nothing that `proxy_http_request` does not already do, at
  eight commands' worth of upkeep.

- **`blockPrivateHosts` is never set on this path.** That flag is the SSRF
  guard the Rust side reads as `blockPrivate`; it is opt-in, and turning it on
  would block loopback — precisely the traffic this bridge exists to carry. The
  adapter passes `proxyFetch` un-wrapped so no wrapper can inject it, and a test
  pins that identity.

- **`ProviderCoreRuntimeInitializer` installs the adapters once at boot**, in
  the deferred-boot bundle ahead of `RoutingRuntimeInitializer` and
  `GatewayProvider`, mirroring the `provider-routing` precedent. The headless
  brain host registers the same adapters through
  `lib/headless/runtimes/initializers.ts`. Without this, `provider-core` keeps
  its inert default and the whole surface is dead on the desktop.

- **Streaming pull is the single Rust exception.** `/api/pull` is NDJSON held
  open for the download, and `proxy_http_request` returns a buffered
  `body: String` — a caller would see nothing for minutes, then every progress
  line at once, after the download finished. `ollama_pull_model_stream` streams
  it server-side and emits one event per line, scoped by a `pullId` so
  concurrent pulls cannot cross streams. The NDJSON reader lives in
  `cognia-net::ndjson_stream`, a sibling of `http_download` — the same
  "stream and report as you go" pattern, a different sink.

- **Capabilities are probed, not guessed.** `/api/show` reports a `capabilities`
  array; its eight values are fixed by the upstream `types/model/capability.go`
  enum, which the published OpenAPI schema does not enumerate. Real context
  length comes from `model_info` under an **architecture-prefixed** key
  (`llama.context_length`, `qwen2.context_length`, `gemma4.context_length`, …)
  because Ollama's GGUF reader prepends `general.architecture` to any key
  outside the `general.` and `tokenizer.` namespaces. Name-substring matching
  survives only as a fallback for servers too old to report capabilities, and
  its results carry `inferred: true` so a guess is never presented as a fact.

- **Embeddings use `/api/embed`, batched.** The deprecated `/api/embeddings`
  accepts a single `prompt`, which is what forced one HTTP round-trip per text.
  `/api/embed` takes an array in `input` and always answers with a 2-D
  `embeddings`, so a batch of N is one request. A response whose length does not
  match the input is rejected rather than misaligned onto the wrong texts.

- **The UI does not claim knowledge it lacks.** Two consequences:
  - `InstallCheckResult.installed` is tri-state. A reachable server proves
    installed *and* running; silence proves nothing — "not installed",
    "installed but stopped" and "listening elsewhere" are indistinguishable — so
    unreachable yields `undefined`, never `false`. The settings page's
    "installed" tally, which was derived from the same value as "running" and so
    was provably always equal to it, is gone; only "running" is reported.
  - Cancelling a pull stops *reporting*, not downloading. Ollama's server cannot
    cancel a pull — aborting the connection leaves the transfer running to
    completion ([ollama#13142](https://github.com/ollama/ollama/issues/13142),
    open) — so there is no cancel command, and the UI says the download
    continues in the background rather than implying the bytes stopped.

## Consequences

- Local-provider management works in the packaged desktop app for the first
  time: scanning detects running servers, model lists load, delete and stop
  take effect, pull reports real progress, and Ollama embeddings no longer throw
  on the Twin/RAG path.
- Every future `provider-core` network call inherits the Rust transport for free
  — but only while the initializer stays mounted. It is boot-order-sensitive and
  pinned by a mount-order test; dropping it re-breaks the whole surface silently
  in the packaged build while `pnpm dev` continues to look fine.
- Batched embeddings change Ollama's request count from N to 1 per batch. A
  server that returns a short array now fails loudly instead of quietly
  corrupting retrieval.
- `localai` and `jan` advertise `canPullModels` / `canDeleteModels` but only
  Ollama's protocols are implemented; those calls report failure rather than
  invoking commands that do not exist. Implementing their gallery APIs is
  deliberately out of scope and flagged rather than silently widened.
- The dead `invoke` branches are gone, so the class of bug where a mocked
  `invoke` certifies an unwritten command cannot recur in this module. Tests now
  assert the transport (proxy vs bare fetch) rather than a command name.

## Alternatives considered

- **Write the eight Rust commands.** Rejected: `proxy_http_request` already
  serves every non-streaming call. This trades eight commands of maintenance for
  no capability.
- **Widen `connect-src` to allow `http:`.** Rejected, and it cannot work anyway:
  a user's server URL is a runtime value while CSP is a build-time constant, so
  the policy cannot express it without a wildcard that weakens every origin in
  the app. This is the same conclusion ADR-0074 reached for OTLP.
- **Use `/api/tags` → `details.families` to detect vision**, as a cheaper
  alternative to a per-model `/api/show`. Rejected on evidence: upstream only
  appends the base model layer's architecture to `ModelFamilies`, never the
  projector's, so `clip` does not appear there. Only `mllama` does. The shortcut
  would silently under-report vision models.
