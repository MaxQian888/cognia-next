// Frontend wrapper around the `codex_oauth_discover` Tauri command. Used by
// the "Reuse" mode of the Codex login dialog and by env-builder when our own
// vault has no active codex account but the user has codex-cli already
// logged in.

import {
  codexOauthDiscover,
  type DiscoveredCodexAuth,
  type DiscoveredCodexTokens,
} from "../core/transport"
import type { CodexCredentialData, ProviderCredential } from "../core/types"

export type { DiscoveredCodexAuth, DiscoveredCodexTokens }

/**
 * Probe `~/.codex/auth.json` + codex-cli's keyring entry. Returns `null`
 * when no codex-cli credential is present anywhere; the rejected case is
 * reserved for actual parse failures (renderer surfaces as "credential
 * corrupted").
 *
 * E2E hook: under `NEXT_PUBLIC_E2E=1` the renderer may publish a synthetic
 * payload via `window.__cogniaE2ECodexDiscovery` to drive the adopt flow
 * without writing to the real `~/.codex/auth.json`. Setting it to `null`
 * exercises the "no credential found" branch; setting it to `undefined`
 * (or omitting it entirely) falls through to the Rust command.
 */
export async function discoverCodexAuth(): Promise<DiscoveredCodexAuth | null> {
  if (typeof window !== "undefined") {
    const w = window as { __cogniaE2ECodexDiscovery?: DiscoveredCodexAuth | null }
    if (w.__cogniaE2ECodexDiscovery !== undefined) {
      return w.__cogniaE2ECodexDiscovery
    }
  }
  return await codexOauthDiscover()
}

/**
 * Translate a `DiscoveredCodexAuth` into the shape we persist into our own
 * vault. This is the "Adopt" operation: copy fields verbatim, never mutate
 * codex-cli's source files.
 *
 * Returns `null` when the discovered payload has neither a ChatGPT bearer
 * nor an API key (in which case the renderer should treat it as "credential
 * present but unusable" and stay logged-out).
 */
export function discoveredToCredential(
  discovered: DiscoveredCodexAuth,
  nowMs: number = Date.now()
): CodexCredentialData | null {
  const stored = {
    originalSource: discovered.source,
    storedAtMs: nowMs,
  } satisfies Pick<CodexCredentialData, "originalSource" | "storedAtMs">

  if (discovered.tokens && discovered.tokens.accessToken) {
    return chatGptCredentialFrom(discovered.tokens, stored)
  }
  if (discovered.openaiApiKey) {
    return apiKeyCredentialFrom(discovered.openaiApiKey, stored)
  }
  return null
}

/**
 * Wrap a `CodexCredentialData` into the tagged `ProviderCredential` union the
 * vault APIs accept.
 */
export function toCodexProviderCredential(c: CodexCredentialData): ProviderCredential {
  return { provider: "codex", ...c }
}

function chatGptCredentialFrom(
  tokens: DiscoveredCodexTokens,
  stored: Pick<CodexCredentialData, "originalSource" | "storedAtMs">
): CodexCredentialData {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    idTokenRaw: tokens.idTokenRaw,
    expiresAtMs: 0,
    authMode: "chatgpt",
    email: tokens.email,
    chatgptPlanType: tokens.chatgptPlanType,
    chatgptUserId: tokens.chatgptUserId,
    accountId: tokens.accountId ?? tokens.chatgptAccountId,
    ...stored,
  }
}

function apiKeyCredentialFrom(
  apiKey: string,
  stored: Pick<CodexCredentialData, "originalSource" | "storedAtMs">
): CodexCredentialData {
  return {
    accessToken: apiKey,
    refreshToken: "",
    idTokenRaw: "",
    expiresAtMs: 0,
    authMode: "api_key",
    ...stored,
  }
}
