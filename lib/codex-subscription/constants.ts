// Endpoints, client_id, scopes, and env-var names for the Codex (OpenAI)
// subscription subsystem. All values mirror what codex-cli ships in
// `openai/codex` `codex-rs/login/src/auth/manager.rs` so the user's ChatGPT
// session scopes carry over seamlessly.
//
// Treat these as public-knowledge constants — they're extracted from the
// open-source codex-cli binary and reproduced here so the renderer can render
// the verification URL + user code without needing to embed OpenAI URLs at
// individual call sites.

/** Codex / ChatGPT first-party client_id. Same value codex-cli uses. */
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"

/** Device-code authorisation endpoint. */
export const CODEX_OAUTH_DEVICE_CODE_URL = "https://auth.openai.com/oauth/device/code"
/** Token grant + refresh endpoint. */
export const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token"
/** Token revoke endpoint. Hit during full Sign Out (vs local-only clear). */
export const CODEX_OAUTH_REVOKE_URL = "https://auth.openai.com/oauth/revoke"

/** Default OAuth scopes. `offline_access` is what mints the refresh token. */
export const CODEX_OAUTH_SCOPES = "openid profile email offline_access"

/**
 * Environment-variable names codex-cli (and the @zed-industries/codex-acp
 * adapter our external-agent preset spawns) recognise. The env-builder
 * picks one based on the credential's `authMode` — `CODEX_ACCESS_TOKEN`
 * for `chatgpt`, `OPENAI_API_KEY` for `api_key`. `CODEX_API_KEY` is also
 * accepted by codex-cli as an alias for `OPENAI_API_KEY`.
 */
export const CODEX_ENV_VARS = {
  /** ChatGPT-issued bearer JWT. Recognised by codex-cli for ChatGPT mode. */
  ACCESS_TOKEN: "CODEX_ACCESS_TOKEN",
  /** Raw OpenAI API key. Recognised by codex-cli and by the OpenAI SDK. */
  OPENAI_KEY: "OPENAI_API_KEY",
  /** codex-cli alias for OPENAI_API_KEY. */
  CODEX_KEY: "CODEX_API_KEY",
} as const

/** Keyring service codex-cli writes to when configured for keyring storage. */
export const CODEX_CLI_KEYRING_SERVICE = "Codex Auth"

/** Default poll interval (ms) for the device-code flow if the server omits one. */
export const CODEX_DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000

/** Maximum poll duration before we surface "expired_token" client-side. */
export const CODEX_DEVICE_CODE_MAX_DURATION_MS = 15 * 60 * 1000

/** Refresh leeway used by `isCodexCredentialFresh` — 60s by default. */
export const CODEX_CREDENTIAL_FRESH_GRACE_MS = 60_000
