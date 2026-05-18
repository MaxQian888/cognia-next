// Anthropic credential — re-export of the shared vault type so callers can
// reach `AnthropicCredentialData` via `subscription::anthropic::credential` if
// they want the provider-scoped path. The data shape itself lives in
// `subscription::vault` (alongside Codex and OpenCode variants) because it's
// referenced from the `ProviderCredential` enum.

#[allow(unused_imports)]
pub use crate::subscription::vault::AnthropicCredentialData;
