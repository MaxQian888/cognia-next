// Codex credential — re-export of the shared vault type. The data shape lives
// in `subscription::vault::CodexCredentialData` (alongside Anthropic / OpenCode
// variants) because it's referenced from the `ProviderCredential` enum.

#[allow(unused_imports)]
pub use crate::vault::CodexCredentialData;
