---
title: ADR-0048 — Codex support expansion (usage tracking · chat provider · ACP fidelity)
description: "Expand OpenAI Codex support beyond the existing credential-reuse + ACP-execution layers: add background usage/limits tracking at Anthropic parity, make Codex a first-class chat provider for both ChatGPT-login (ChatGPT backend Responses API + headers) and api_key modes, and harden the ACP permission-mode/terminal-write fidelity gaps. Records the prior research, the openai/codex upstream study that corrected the transport design, and the approved D→B→C plan."
---

# ADR-0048 — Codex support expansion

**Status**: Accepted (2026-06-18)
**Authors**: Max Qian + Claude Opus 4.8
**Builds on**: ADR-0025 (unified subscription vault; Codex credential reuse), ADR-0010 (usage-tracking pipeline), ADR-0043 (LLM provider execution / `resolveSendOptions` credential plumbing), and the external-agent ACP layer (`lib/ai/agent/external/`, `src-tauri/src/external_agent/`).

## Context

Codex was already **mature across three layers** before this work, established
by prior ADRs and confirmed by a read-only research sweep:

- **Credential / subscription reuse** (ADR-0025): `lib/subscription/codex/` +
  `src-tauri/src/subscription/codex/` — discovery of `~/.codex/auth.json` and
  the codex-cli keyring, device-code OAuth, ChatGPT-bearer vs API-key modes,
  multi-account vault, presets, cloud sync.
- **ACP execution**: `AgentRuntime="external"` runs Codex via
  `npx @zed-industries/codex-acp` over ACP/stdio (the only *executable* preset).
- **Config interop**: MCP-server sync to `~/.codex/config.toml`, subagent
  import, TUI theme reuse.

The research found three genuine gaps, which this ADR addresses without
omission or simplification:

- **B — usage tracking**: no background usage/limits loop (Anthropic has one);
  the on-demand limits source mis-parsed the backend response shape.
- **C — chat provider**: Codex was not selectable as a chat model — only the
  external-agent path could run it; it was absent from `packages/provider-core`
  and the built-in provider catalog.
- **D — ACP fidelity**: permission modes `plan`/`dontAsk` were typed but never
  honored, `acceptEdits` covered writes only, the `terminal/write` handler was
  missing, and the Rust terminal/process modules had no tests.

### Upstream study (`openai/codex`) that shaped the design

- **ChatGPT-login transport** uses the **Responses API at the ChatGPT backend**
  (`https://chatgpt.com/backend-api/codex`), **not** `api.openai.com/v1`;
  `chat/completions` is removed. It requires `Authorization: Bearer`,
  `ChatGPT-Account-Id`, `Originator`, `OAI-Product-Sku: codex`, `OpenAI-Beta`,
  `User-Agent: codex-cli`. This corrected an initial wrong assumption and is the
  core of Phase C.
- **Rate limits**: `RateLimitSnapshot { primary, secondary, credits }`, each
  window `{ used_percent, window_minutes, resets_at }` — drove the Phase B
  source fix (prior code read `reset_at`, omitted `window_minutes`).
- **Native `codex app-server`** (JSON-RPC `thread/start` / `turn/start` /
  `item/*` approvals) exists as a first-party alternative to the zed-codex-acp
  shim — recorded as future work; this pass hardened the existing ACP path.

## Decision

Implement all three gaps as **independent, risk-ascending phases (D → B → C)**,
each its own commit with co-located tests and gates. Chat-provider support
covers **both** auth modes (no simplification).

### Phase D — ACP execution fidelity
`lib/ai/agent/external/acp-client.ts`: honor `plan` and `dontAsk` (auto-reject
without UI — `plan` = no execution, `dontAsk` = deny unless pre-approved);
extend `acceptEdits` to auto-approve read/list ops (side-effecting kinds still
prompt); add the `terminal/write` handler (delegates to the existing
`acpTerminalWrite` native binding). Add the missing `#[cfg(test)]` modules to
`src-tauri/src/external_agent/{terminal,process}.rs`.

### Phase B — Codex usage/limits tracking (Anthropic parity)
Fix `lib/subscription/limits/sources/codex.ts` to parse `resets_at` +
`window_minutes` (legacy fallback kept). Add `probeCodexUsage` (thin wrapper over
the unified `queryAccountLimits` + `recordLimitsSnapshot`) and a visibility-aware
`startCodexUsageScheduler` reusing the shared cadence floor. Mount it at boot via
`CodexUsageSchedulerInitializer` (desktop-only, self-gated on `probeEnabled`) so
it is reachable, not dormant. Surface probe controls in the Codex subscription
tab, bilingual. Reuses the entire `providerLimits` persistence + meter-render
stack unchanged.

### Phase C — Codex as a first-class chat provider
Register `codex` in `BUILT_IN_PROVIDER_IDS` + catalog + `PROVIDERS` metadata
(surfaces via the catalog quick-add shortcut, like opencode). Add
`resolveCodexVaultCredential` (mirrors the opencode chat-bridge): **api_key** →
genuine OpenAI; **chatgpt** → ChatGPT backend + the required headers; a preset
baseUrl overrides either. Force the Responses API for codex in both the
provider-core client and the sidecar adapter (the ChatGPT backend host isn't
`*.openai.com`, so the genuine-endpoint check would wrongly pick chat
completions). Thread a new `providerCredentials.headers` field end-to-end:
`resolveSendOptions` → the Rust `ProviderCredentials` struct (a strictly-typed
struct would otherwise drop it at the boundary) → the sidecar `createOpenAI`.

## Consequences

- A reused ChatGPT Codex subscription (or an OpenAI API key) is usable directly
  in chat with zero extra setup — the same convenience the Anthropic/OpenCode
  subscription paths already have — and as a background usage meter.
- The chat send for `codex` flows through the **same PII redaction gate** as
  every other provider (credential resolution only; no new send path).
- `providerCredentials.headers` is now a general capability other
  header-sensitive providers can reuse.
- Out of scope (future): a native `codex app-server` adapter; Codex
  credit/balance adapters beyond windowed usage; runnable spawn definitions for
  the claude-code/gemini-cli/cursor-cli presets.

## Verification

Jest 316 / 11 suites; sidecar `node --test` 63; Rust `cargo test` 14; typecheck
0 new errors over the pre-existing dev baseline; ESLint clean; i18n key parity +
sort OK; the six project auditors (test-gap, i18n, static-export, tauri-rust,
pii-gate, wiring) clean.
