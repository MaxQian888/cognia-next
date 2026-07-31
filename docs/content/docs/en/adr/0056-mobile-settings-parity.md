---
title: ADR-0056 — Mobile settings parity
description: "Bring the Capacitor mobile settings surface (/me) to full parity with the desktop Settings, with standalone (BYOK) as the main line. Resolve the core tension — the standalone in-webview engine runs no tools/agent loop — by mode-gating agent-class settings: they remote-edit the desktop sidecar in paired mode and are hidden in standalone mode, rather than shipping dead UI or blocking the work on a much larger engine rewrite. Reuse desktop section components where they are settings-store-driven, and expand the companion app_settings_update allowlist to cover the agent preference fields that already sync down but are not yet writable back, with permissionMode gated behind biometric/can_control."
---

# ADR-0056 — Mobile settings parity

**Status**: Proposed (2026-06-28)
**Authors**: Max Qian + Claude
**Builds on**: ADR-0014 (Capacitor mobile shell), ADR-0015 (mobile v2 completion), ADR-0021 (WebRTC WAN transport — companion `app_settings_update` allowlist precedent), ADR-0027 (mobile sync orchestrator), ADR-0041 (agent command auto-mode). See `CONTEXT.md` for the domain glossary and decisions D1–D5.

## Context

The phone is a Capacitor shell over the same Next.js static export the desktop Tauri app ships. Its settings center is the `/me` route (NOT desktop `/settings`): a data-driven iOS-style list (`components/mobile/me/me-entries.ts`) of 24+ `/me/*` sub-pages with search, favorites, and six groups. It is already substantial — appearance reuses the full desktop `<AppearanceSection/>`, BYOK providers, sync, storage, backup, biometric, and device info are all wired and tested.

The goal is **full settings parity, not a simplified subset**. Two facts shape how that is even possible:

1. **The phone runs in one of two modes** (`AppSettings.mobileRuntimeMode`, device-local, never synced):
   - **Standalone (BYOK)** — self-sufficient, chat runs in the webview via `lib/ai/chat/standalone-engine.ts`.
   - **Paired (companion)** — a remote client of a Tauri desktop; work executes on the desktop sidecar.

2. **The standalone engine is a plain AI SDK `streamText` call.** It consumes only the model and the composed system prompt. It runs **no tools, no MCP, no agent loop, no permission modes, no `autoMode`/`toolFilter`/thinking budget.** Any agent-class setting shown on a *standalone* phone has no consumer today — it would be dead UI, this repo's most recurrent defect class.

A third fact constrains the wire/security boundary. Setting sync is asymmetric:
- Desktop → phone mirrors 19 keys (`CROSS_PLATFORM_SETTING_KEYS`), **including** the agent fields `autoMode`, `permissionMode`, `defaultSystemPrompt`, `defaultMaxThinkingTokens`, `bareMode`, `debugMode`, `briefMode`.
- Phone → desktop allows ~36 keys (`APP_SETTINGS_MOBILE_ALLOWED_KEYS` in `src-tauri/src/companion_api/rpc.rs`), enforced server-side with OpenAPI spec-parity + Rust tests. The agent fields above are **NOT** in it: the phone sees them but cannot edit them back. `apiKey`, `apiBaseUrl`, provider config, `sidecarPath`, and transport keys are asserted *non-writable* from mobile and stay that way.

We evaluated three ways to resolve the agent-settings tension:

- **A. Mode-gate the agent-class settings.** Expose them only in paired mode, where they remote-edit the desktop sidecar (a real backend); hide them in standalone. No dead UI; the settings effort stays a settings effort.
- **B. Extend the standalone engine to a real agent loop first.** Give BYOK genuine tools/MCP/permission modes so the settings have a consumer in both modes. This is a large feature initiative far exceeding "settings", and would block all parity work behind it.
- **C. Show the panels in both modes; in standalone they persist but do nothing.** Explicitly rejected — dead UI that silently no-ops is exactly the built-but-dormant anti-pattern.

## Decision

The decisions are recorded canonically in `CONTEXT.md` (D1–D5); summarized here:

- **D1 — Parity target.** Both modes reach full parity; standalone (BYOK) is the main line. No simplified subset.
- **D2 — Agent-class settings are mode-gated (chooses option A).** Agent Runtime / tool filter / MCP / permission modes / slash commands are exposed only in **paired** mode (remote-edit the desktop sidecar) and hidden/disabled in **standalone** mode. Extending the standalone engine to a real agent loop is a separate future initiative, not part of this work.
- **D3 — Build strategy: hybrid, default reuse.** Pure settings-store-driven desktop sections embed directly into a `/me/*` `SubPageShell` (as `/me/appearance` already does). Complex sections with Tauri-only tabs (e.g. agent-runtime's sidecar/SDK tabs) are reused but gate those tabs out by platform/mode. No full mobile-native rewrites.
- **D4 — `permissionMode` remote-write is gated.** `permissionMode` joins the write allowlist, but a remote write — especially an escalation toward `bypassPermissions`/`acceptEdits` — must pass the existing `biometricRequiredFor` / companion `can_control` gate, not a bare preference write. The other bucket-1 fields write normally.
- **D5 — Coverage: buckets 1+2+3 (full).** Bucket 4 (provider credentials, sidecar/transport, LSP, sandbox, source-control, workspace-trust, companion server, computer-use execution) stays desktop-only.

### Scope buckets

- **Bucket 1 — synced-down but not editable.** `autoMode`, `permissionMode` (gated per D4), `defaultSystemPrompt`, `defaultMaxThinkingTokens`, `bareMode`, `debugMode`, `briefMode`. Needs allowlist expansion + mobile UI.
- **Bucket 2 — present pages missing options.** Audit each `/me/*` page against its desktop section and fill gaps (preferences, conversation, speech, ocr, web-search, notifications).
- **Bucket 3 — absent desktop sections.** External Agents, MCP (http/SSE), Slash Commands, Skills/Subagents/Characters management, Plugins management, Agent Teams, Workflows settings, Network, Instructions, GitHub Delivery, Hooks. Mode-gated per D2 where they touch the agent runtime.
- **Bucket 4 — excluded.** As in D5.

## Rollout (waves)

Each wave ships with: co-located tests ≥90% lines/branches/functions, i18n keys in **both** `en.json` and `zh-CN.json` + `pnpm lint:i18n`, mode-gating per D2, and a `preflight` pass before commit. Bucket-3 sections ship one section per PR, each user-confirmed.

- **Wave 0 — Enablers.**
  - Settings-side runtime-mode gating helper so agent panels render only in paired mode (D2).
  - Expand `APP_SETTINGS_MOBILE_ALLOWED_KEYS` with bucket-1 fields; `permissionMode` behind the D4 gate. Keep `src-tauri` Rust unit tests, the OpenAPI `spec_parity` check, and the `lib/settings/section-keys.ts` mirror in lockstep.
- **Wave 1 — Bucket 1 UI.** `/me/agent` (or an extension of `/me/preferences`) exposing the agent defaults, reusing the touch-safe parts of the desktop agent-runtime defaults tab (D3).
- **Wave 2 — Bucket 2 completeness.** Per-page audit and gap-fill of existing `/me/*` pages.
- **Wave 3+ — Bucket 3.** One section per PR in the order above.

## Consequences

- The companion write allowlist is a security contract with a wire spec and tests; every bucket-1/bucket-3 field added to it must update the Rust const, the OpenAPI spec, the `section-keys.ts` mirror, and the parity tests together, or CI fails. This friction is deliberate.
- Mobile settings UX now formally depends on `mobileRuntimeMode`: the same `/me` list shows a different set of agent panels in standalone vs paired. A future reader seeing an agent panel "missing" on a standalone phone should consult D2 here, not treat it as a bug.
- Standalone BYOK users do **not** get agent-runtime/MCP/tools settings until the separate engine-extension initiative lands. This ADR records that exclusion as intentional.
- Provider credentials remain split: device-local BYOK keys via `/me/providers` (never synced, never remotely writable) vs desktop-only provider config. Mobile never becomes a remote editor of desktop credentials.
