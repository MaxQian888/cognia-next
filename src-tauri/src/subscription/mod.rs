// Unified subscription / OAuth credential vault (ADR 0025).
//
// Consolidates what was historically two siblings — `anthropic_subscription/`
// (PKCE flow for Claude Pro/Max + Console) and `codex_subscription/`
// (device-code flow for ChatGPT Codex) — into one module with a shared
// `ProviderVault` storage layer, a thin `SubscriptionProvider` trait, and a
// third provider (`opencode`, read-only discovery + paste-Zen-key).
//
// Storage shape (one keyring entry per provider):
//   service = "com.cognia.subscription/v2"
//   account = "anthropic" | "codex" | "opencode"
//   payload = JSON-encoded `ProviderVault { schemaVersion: 2, accounts: [...],
//             activeAccountId: Option<UUIDv7>, preset: Option<ProviderPreset> }`
//
// Anthropic usage tracking (rate-limit header parsing + Dexie + active probe)
// is **deliberately** not abstracted into the trait; it lives in TS and
// stays Anthropic-specific (the explicit non-goal of generalization).
//
// Cognia-next never writes to the upstream credential stores (`~/.claude/`,
// `~/.codex/`, `~/.local/share/opencode/`). Those files are owned by the
// respective CLIs; we discover read-only and copy into our own keyring.

pub mod active;
pub mod anthropic;
pub mod codex;
pub mod commands;
pub mod migration;
pub mod opencode;
pub mod preset;
pub mod provider;
pub mod vault;

// Single re-export — `lib.rs` constructs the managed state via
// `subscription::ActiveAccountState::new()`. Every other consumer reaches its
// type through the explicit submodule path (`subscription::vault::Account`,
// `subscription::provider::ProviderId`, etc.) to keep call sites
// self-documenting.
pub use active::ActiveAccountState;
