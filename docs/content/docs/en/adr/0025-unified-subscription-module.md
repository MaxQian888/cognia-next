---
title: "0025 — Unified Subscription Module (Claude + Codex + OpenCode)"
description: "One Rust module + one TS module + one Settings UI tab covering Anthropic PKCE, OpenAI device-code, and OpenCode discovery / Zen paste-key flows. Adds multi-account vaults, third-party endpoint presets, and encrypted import / export. Supersedes ADR 0010 for storage and multi-account; the Anthropic-specific usage-tracking pipeline remains canonical from 0010."
---

# ADR 0025 — Unified Subscription Module

**Status:** Accepted
**Date:** 2026-05-18
**Branch:** `feat/subscription-unification`
**Supersedes (partially):** [ADR 0010 — Claude Subscription OAuth + Usage Tracking](/docs/en/adr/0010-claude-subscription-oauth) (storage layout + single-account assumption)

---

## Context

By ADR-0010 the codebase had a self-contained `anthropic_subscription` module
in Rust + `lib/anthropic-subscription/` in TS for the Claude Pro/Max PKCE
flow. A follow-up landed `codex_subscription` + `lib/codex-subscription/`
for ChatGPT/Codex device-code OAuth and discovery of `~/.codex/auth.json`.

Both subsystems mirror each other's _intent_ — keep an OAuth credential in
the OS keyring; let the renderer and sidecar consume it — but diverge in
OAuth flow shape, command naming (`claude_sub_*` vs `codex_sub_*`),
credential schema field names, and which fields the JSON blob carries.

Three concrete problems this caused:

1. **OpenCode couldn't be added cleanly.** OpenCode is a multi-provider
   client whose `~/.local/share/opencode/auth.json` holds 75+ provider
   sub-entries plus OpenCode-Zen's own subscription path. Adding it as a
   third sibling directory would have triplicated naming conventions.

2. **Multi-account was blocked.** Both modules hard-coded `account =
"default"` in their keyring layer. Anthropic's mod.rs called out the
   deferral. CC-Switch (the community's de-facto solution for this niche)
   makes "N accounts per provider with hot-switch" table stakes.

3. **Shared invariants lived twice.** Keyring service-name versioning,
   credential schema migration, sidecar wiring, fetch-interceptor parity,
   test gating — all duplicated. Touching one always let the other bit-rot.

This ADR consolidates the three subsystems into one Rust module
(`src-tauri/src/subscription/`) + one TS module (`lib/subscription/`) +
one Settings UI tab (`components/settings/subscription/`).

## Decision

### 1. Three providers behind one trait

```
src-tauri/src/subscription/
  trait.rs          // SubscriptionProvider — sync, pure-data
  vault.rs          // ProviderVault (per-provider keyring blob)
  active.rs         // ActiveAccountState — Tauri state, in-mem cache
  preset.rs         // ProviderPreset (Anthropic + Codex only)
  migration.rs      // v1 → v2 migration (idempotent)
  commands.rs       // 10 shared CRUD commands + active + preset
  anthropic/        // PKCE save-hook (PKCE flow lives in TS)
  codex/            // device-code OAuth + discovery (ported verbatim)
  opencode/         // discovery (whitelist) + paste-Zen-key
```

`SubscriptionProvider` is intentionally pure-data:

```rust
pub trait SubscriptionProvider: Send + Sync {
    fn id(&self) -> ProviderId;
    fn validate(&self, c: &ProviderCredential) -> Result<(), String>;
    fn default_label(&self, c: &ProviderCredential) -> Option<String>;
    fn env_for_sidecar(
        &self,
        a: &Account,
        preset: Option<&ProviderPreset>,
    ) -> Vec<(String, String)>;
    fn requires_sidecar_restart_on_active_switch(&self) -> bool { false }
    fn supports_preset(&self) -> bool { true }
}
```

I/O lives outside the trait: keyring in `vault.rs`, HTTP in each provider's
`oauth.rs`, file-system discovery in `discovery.rs`. The trait stays easy to
unit-test and easy to extend with a fourth provider.

### 2. Per-provider keyring vault with multi-account

```
service = "com.cognia.subscription/v2"
account = "anthropic" | "codex" | "opencode"
payload = JSON-encoded ProviderVault { schemaVersion: 2,
                                       accounts: [Account],
                                       activeAccountId,
                                       preset }
```

`Account` carries a **UUIDv7** id (monotonic + unique without coordination),
an optional user-supplied label, and a tagged-union credential with the
exact field layout of the v1 schemas:

```rust
#[serde(tag = "provider", rename_all = "kebab-case")]
pub enum ProviderCredential {
    Anthropic(AnthropicCredentialData),        // mirrors v1 SubscriptionCredential
    Codex(CodexCredentialData),                // mirrors v1 CodexCredential
    OpencodeDiscovered(OpencodeDiscoveredData),// pointer record from auth.json
    OpencodeZen(OpencodeZenData),              // paste-key flow
}
```

### 3. Migration v1 → v2

On every app boot, `subscription_init` looks for the v1 keyring entries
(`com.cognia.claude-subscription/v1` + `default`, and the codex equivalent),
wraps each into one `Account { id: uuidv7(), label: Some("Default"), ... }`,
writes the v2 vault with `active_account_id = Some(id)`, and **leaves the v1
entry intact** for a 90-day rollback window. Idempotence is enforced via an
access-token comparison: re-running on an already-migrated profile returns
`AlreadyMigrated` without duplicating.

A one-shot React component (`SubscriptionInitializer`) fires
`subscription_init`, then emits a single Sonner toast keyed by
`localStorage["subscription.migrationToastShown"]` so the user only ever
sees it once.

### 4. OpenCode integration — **Discovery + paste-Zen-key**

OpenCode is fundamentally different from Anthropic / Codex: it's a
**multi-provider client** whose own `auth.json` may hold credentials for
75+ upstream providers, plus an OAuth-style entry for the OpenCode-Zen
managed subscription.

We chose a **two-track integration**:

- **Discovery (read-only).** `opencode_oauth_discover` parses
  `~/.local/share/opencode/auth.json` and surfaces only the whitelisted
  sub-providers — `anthropic`, `openai`, `opencode-zen`. Everything else
  is filtered out; cognia doesn't currently know how to consume them.
  The Rust side enforces the whitelist; the TS side re-applies it as
  defence-in-depth.

- **Paste-Zen-key (write).** opencode.ai's OAuth endpoints aren't publicly
  documented as of writing. Rather than reverse-engineer them and ship a
  brittle integration, this round persists a Zen subscription via a
  **paste-API-key dialog**: the user signs in at `opencode.ai/auth`,
  copies the key, and pastes it into cognia. We store it as
  `ProviderCredential::OpencodeZen` with an optional regional base URL.

Full Zen OAuth is intentionally **deferred** until the endpoints are
documented upstream; the paste-key path is the Phase-1 bridge.

### 5. Provider preset (Anthropic + Codex only)

`ProviderPreset { id, label, baseUrl, extraHeaders? }` overrides the
upstream base URL on a per-provider basis — AWS Bedrock for Anthropic,
Azure OpenAI / OpenAI-compatible relays for Codex. OpenCode rejects
presets (it already manages its own multi-provider endpoints inside
`auth.json`; a second redirect layer would just confuse users).

### 6. Encrypted export / import

`lib/subscription/core/encrypted-package.ts` ships a custom envelope
(`cogniabak-subscription-v1`) using the same primitives as the
`lib/data/` Dexie-wide backup — AES-GCM 256 + PBKDF2-SHA256 with 600 000
iterations. The envelope contains a plaintext manifest (provider list +
account counts + ISO timestamp) and an encrypted body holding the full
per-provider vaults. Users back up across machines with `Export…`, restore
with `Import…`. Wrong passphrases surface a distinct `SubscriptionPassphraseError`
so the UI can show "wrong passphrase" instead of a generic decryption error.

### 7. Per-provider active pointer + sidecar wiring

`ActiveAccountState` is a Tauri-managed in-memory cache. For each provider
it stores the active account id + the resolved env vars
(`SubscriptionProvider::env_for_sidecar`). The cache is populated by
`subscription_set_active`; readers (sidecar spawn, external-agent env-builder)
consume it via `subscription_get_active`.

**Anthropic-only side effect**: `subscription_set_active("anthropic", id)`
extracts `CLAUDE_CODE_OAUTH_TOKEN` from the resolved env, pushes it into the
existing `ApiKeyState::set_oauth_bearer`, and calls `kill_sidecar` so the
next `claude_send` spawns with the new bearer. The
`sidecar.rs:143-155` contract (which reads from `ApiKeyState` at spawn time)
is **byte-identical to before** — only the trigger upstream changed.

For Codex / OpenCode there's no sidecar; the external-agent env-builder
reads the active env at spawn time of the codex / opencode CLI subprocess.

### 8. Anthropic usage tracking stays Anthropic-only

The fetch interceptor in `sidecar/fetch-interceptor.mjs`, the parser in
`lib/subscription/anthropic/parser.ts`, the Dexie `subscriptionUsage` table,
the active probe loop, the visibility-aware scheduler — none of these were
abstracted into the trait. OpenAI doesn't emit the unified-rate-limit headers
Claude does, and OpenCode is a downstream proxy; generalising would be a
fictional symmetry. ADR 0010 remains the canonical reference for the
usage-tracking pipeline; ADR 0025 only supersedes its **storage + multi-account**
sections.

## Three-provider capability matrix

| Capability                              | Anthropic                                            | Codex                                      | OpenCode                            |
| --------------------------------------- | ---------------------------------------------------- | ------------------------------------------ | ----------------------------------- |
| Login flow                              | PKCE (paste-the-code)                                | Device-code                                | Discovery + paste-key (Zen / Go)    |
| Client id                               | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` (Claude Code) | `app_EMoamEEZ73f0CkXaXp7hrann` (codex-cli) | n/a (paste-key)                     |
| Source of truth at startup              | v2 vault, then v1 migration once                     | v2 vault, then v1 migration once           | v2 vault only (no v1)               |
| Multi-account                           | yes                                                  | yes                                        | yes                                 |
| Active account triggers sidecar restart | yes                                                  | no (env-builder picks up next spawn)       | no                                  |
| Provider preset                         | yes (Bedrock, custom proxy)                          | yes (Azure, OpenAI-compatible)             | yes (gateway relays/mirrors)        |
| Usage tracking                          | yes (passive + opt-in probe)                         | no (no unified headers)                    | no                                  |

## Amendment 2026-06-07 — OpenCode Go, chat wiring, preset parity, cloud sync

Verified against a live opencode install + the Zen gateway:

1. **Real auth.json keys.** The opencode CLI stores its managed plans under
   `"opencode"` (Zen) and `"opencode-go"` (Go flat-rate plan) with shape
   `{"type":"api","key":"sk-…"}` — the originally assumed `"opencode-zen"`
   spelling never appears (kept in the whitelist for back-compat). The
   discovery whitelist is now
   `anthropic / openai / opencode / opencode-go / opencode-zen`, the
   classifier recognises `type:"api"` / bare `key` fields, and the Windows
   path probe uses `~/.local/share/opencode/auth.json` (XDG-style on every
   platform; `%LOCALAPPDATA%` was wrong) with a LOCALAPPDATA fallback.
2. **Go plan credential.** `OpencodeZenData` gained an optional
   `plan: "zen" | "go"` (additive — vault `SCHEMA_VERSION` stays 3; absent =
   zen). `opencode_save_zen_key` takes an optional `plan` param;
   `env_for_sidecar` always emits `OPENCODE_BASE_URL` (preset > account
   override > plan default: Zen `https://opencode.ai/zen/v1`, Go
   `https://opencode.ai/zen/go/v1`).
3. **Chat providers.** Two built-in chat providers `opencode` / `opencode-go`
   (OpenAI-compatible, verified live via `/models` + `/chat/completions`).
   When Settings → Providers holds no API key, `resolveSendOptions` falls
   back to the subscription vault via
   `lib/subscription/opencode/chat-bridge.ts` (active account first, then
   most-recently-used account of the matching plan; bound/default preset
   base URL wins).
4. **Preset parity.** `supports_preset()` is now true for OpenCode; presets
   model relays/mirrors in front of the managed gateway and emit
   `OPENCODE_BASE_URL` / `OPENCODE_MODEL` / `OPENCODE_CUSTOM_HEADER_*`. We
   still never write back to OpenCode's own auth.json.
5. **Cloud sync.** The previously deferred vault cloud sync shipped as a
   WebDAV pipeline parallel to the data backup: encrypted
   `cogniabak-subscription-v1` envelopes under
   `cognia-subscription-<ts>.cogniabak.json` + a `latest-subscription`
   pointer, own passphrase (session + opt-in keyring), own toggle
   (`webdavSync.subscriptionSyncEnabled`), debounced auto-upload off a
   transport-layer dirty marker, restore-with-preview. See
   `lib/subscription/sync/`.
| Discovery of external CLI auth          | n/a (no Claude Code CLI auth.json)                   | `~/.codex/auth.json` + codex-cli keyring   | `~/.local/share/opencode/auth.json` |

## Amendment 2026-06-11 — billing maturation (plugin balance adapters, chat commands, non-resident sync)

1. **Pluggable balance adapters.** The balance-adapter registry is no longer a
   closed array. A new `balance-adapter` plugin capability
   (`types/plugin/plugin-balance-adapter.ts`,
   `lib/plugin/registries/balance-adapter-registry.ts`, wired through
   `OVERLAY_REGISTRY_CAPABILITIES`) lets a plugin contribute a
   `PluginBalanceAdapterDef` via `manifest.balanceAdapters[]`. `findBalanceAdapter`
   now consults the overlay registry **before** the built-in adapters, so a
   plugin can extend or override the bundled set. Reference implementation:
   `plugins/agent-team-examples/src/demo-balance-adapter.ts`.
2. **Chat-side billing commands.** New built-in slash commands surface the
   subscription data in chat: `/usage` (Anthropic 5h/7d quota windows, reusing
   `summarizeCurrentWindow`), `/balance` (latest per-account snapshots via
   `latestBalanceSnapshot`), `/models` (catalog sync via `syncModelsDevCatalog`),
   and `/login` (opens Settings → Subscription). See
   `lib/slash-commands/actions/billing.ts`.
3. **Non-resident sync surfaces.** The always-mounted models.dev and
   subscription WebDAV sync cards collapse to a shared compact `SyncStatusStrip`
   (`components/settings/_shared/`): a small Sync button plus a transient status
   line that disappears when idle; the subscription controls move behind a
   collapsed-by-default panel.

## Renderer-side IPC surface

> **Amended 2026-07-25.** Two things drifted from the list below.
>
> 1. **The count is 28, not 20.** The v3 preset *library* commands
>    (`subscription_list_presets`, `subscription_save_preset`,
>    `subscription_delete_preset`, `subscription_set_default_preset`), the
>    generic `subscription_authed_get`, `subscription_volcengine_usage`, and the
>    ADR-0028 env resolvers (`claude_env_for_account`,
>    `claude_proxy_env_for_session`) all landed after this section was written.
> 2. **The implementation moved.** Per ADR-0067, the vault / active-pointer /
>    preset / per-provider discovery + OAuth logic now lives in
>    `crates/cognia-subscription/`; `src-tauri/src/subscription/` is a thin
>    re-export facade plus the Volcengine SigV4 usage command. Paths quoted
>    elsewhere in this ADR should be read against the crate.

20 commands total registered in `src-tauri/src/lib.rs`:

Shared (10): `subscription_init`, `subscription_list_accounts`,
`subscription_get_account`, `subscription_save_account`,
`subscription_delete_account`, `subscription_rename_account`,
`subscription_set_active`, `subscription_get_active`,
`subscription_get_preset`, `subscription_set_preset`.

Anthropic-specific (1): `anthropic_oauth_save_pkce_result` (PKCE flow runs in
TS; this hook only persists the result).

Codex-specific (5): `codex_oauth_discover`,
`codex_oauth_request_device_code`, `codex_oauth_poll_device_code`,
`codex_oauth_refresh`, `codex_oauth_revoke`.

OpenCode-specific (2): `opencode_oauth_discover`, `opencode_save_zen_key`.

Encrypted export / import is **rendererr-side only** (`lib/subscription/core/encrypted-package.ts`)
— the secrets are already in renderer state when the user clicks Export, so
routing through Rust just to write JSON would add complexity for no security
gain.

## Consequences

**Wins**

- Three providers share one IPC surface, one settings tab, one credential
  schema (modulo per-variant payload fields).
- Multi-account + label + one-click switch ship as a single feature with no
  per-provider repetition.
- Encrypted export/import means a fresh machine boots ready in two clicks
  (Import → enter passphrase).
- The trait is small enough to add a fourth provider in a few hundred lines.

**Trade-offs**

- OpenCode-Zen integration is paste-key today; full OAuth waits on documented
  endpoints upstream.
- Auto-discovery of `~/.codex/auth.json` is no longer a runtime fallback —
  users adopt discovered credentials explicitly through the "Reuse" flow.
  The plan's open question #3 confirmed this trade-off (Account tab makes
  the discovery visible so the UX cost is low).
- The companion API RPC bridge swapped from `claude_sub_*` / `codex_sub_*`
  names to the unified `subscription_*` surface; mobile clients on the old
  names get `unknown_command` 404s and need a coordinated update.

**Out of scope (will land later)**

- Cloud sync of the vault (Dropbox / OneDrive / WebDAV à la CC-Switch).
- Local proxy auto-failover (Settings → Providers handles this today via
  CCSwitch interop).
- Full OAuth into opencode.ai for Zen (waiting on upstream).
