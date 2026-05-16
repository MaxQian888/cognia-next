// Codex (OpenAI) subscription credential vault — the parallel to
// `anthropic_subscription/` for ChatGPT-backed Codex CLI users.
//
// Two ingestion paths:
//
//   1. Discovery — we read the existing `~/.codex/auth.json` (or the OS
//      keyring under service name "Codex Auth" when the user opted into
//      keyring storage). The renderer surfaces this as the *Reuse* mode of
//      the login dialog: one click to copy the credential into cognia's own
//      keyring slot so downstream consumers (env injection for the external
//      codex agent, ccswitch propagation) can read it via a stable IPC
//      surface. We **never write back** to ~/.codex/auth.json — that file
//      is owned by codex-cli, and double-writing risks racing with
//      `codex login`.
//
//   2. OAuth — when no codex-cli credential exists locally, we run the
//      OpenAI device-code flow (CLIENT_ID matches codex-cli's so the user's
//      ChatGPT account scopes carry over). The resulting tokens are written
//      to our own keyring, never to ~/.codex/.
//
// Our keyring service name `com.cognia.codex-subscription/v1` is deliberately
// disjoint from codex-cli's `"Codex Auth"` keyring entry. The frontend never
// addresses the codex-cli keyring entry directly — `discovery::load_keyring`
// reads it via the same `keyring` crate but bypasses our entry.

pub mod commands;
pub mod credential;
pub mod discovery;
pub mod oauth;
