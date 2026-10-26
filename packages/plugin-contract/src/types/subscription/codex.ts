// Codex chat-provider helpers. The credential shape (`CodexCredentialData`)
// lives in `./credential` because it's part of the `ProviderCredential` union;
// this module holds the chat-provider id guard + the endpoint constants the
// chat bridge resolves against.

/**
 * Genuine-OpenAI base URL used by api-key mode (standard Responses API).
 */
export const CODEX_DEFAULT_API_BASE_URL = "https://api.openai.com/v1"

/**
 * ChatGPT-login backend used when reusing a ChatGPT Codex subscription. Codex
 * normalizes this to `…/backend-api` + the Responses path; the AI SDK appends
 * `/responses`. Mirrors `Client::new` in `codex-rs`.
 */
export const CODEX_CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex"

/** The single chat-provider id backed by the Codex subscription vault. */
export const CODEX_CHAT_PROVIDER_ID = "codex" as const

export function isCodexChatProviderId(id: string): id is "codex" {
  return id === CODEX_CHAT_PROVIDER_ID
}
