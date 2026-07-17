// Frontend wrapper around the `codex_oauth_discover` Tauri command. Used by
// the "Reuse" mode of the Codex login dialog and by env-builder when our own
// vault has no active codex account but the user has codex-cli already
// logged in.

import {
  codexOauthDiscover,
  type DiscoveredCodexAuth,
  type DiscoveredCodexTokens,
} from "../core/transport"
import type { CodexCredentialData, ProviderCredential } from "@/types/subscription"

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
    // A ChatGPT-login access token is a short-lived JWT, but codex-cli's
    // auth.json stores no separate expiry — so read it from the token itself.
    // When it can't be decoded, fall back to "already expired" (storedAtMs) so
    // the first use refreshes via the long-lived refresh_token.
    //
    // The old hard-coded `0` made `isCodexCredentialFresh` report the credential
    // fresh forever (the `expiresAtMs === 0` branch), so a reused ChatGPT
    // subscription was NEVER refreshed and 401'd on both the chat and the
    // external-agent spawn paths the moment its stored bearer aged out — i.e.
    // "reuse the codex-cli login" adopted a subscription that stopped working.
    expiresAtMs: accessTokenExpiryMs(tokens.accessToken) ?? stored.storedAtMs,
    authMode: "chatgpt",
    email: tokens.email,
    chatgptPlanType: tokens.chatgptPlanType,
    chatgptUserId: tokens.chatgptUserId,
    accountId: tokens.accountId ?? tokens.chatgptAccountId,
    ...stored,
  }
}

/**
 * Extract the `exp` claim (as epoch ms) from a JWT access token. ChatGPT-login
 * access tokens are JWTs; the `exp` is what `isCodexCredentialFresh` compares
 * against to decide when to renew via the refresh_token. Returns `null` when the
 * token isn't a decodable JWT carrying a positive numeric `exp` (e.g. an opaque
 * token) — the caller then treats it as already-expired and refreshes on first
 * use.
 */
function accessTokenExpiryMs(accessToken: string): number | null {
  const parts = accessToken.split(".")
  if (parts.length < 2) return null
  try {
    const payload = base64UrlToString(parts[1])
    const claims = JSON.parse(payload) as { exp?: unknown }
    const expSeconds = typeof claims.exp === "number" ? claims.exp : null
    return expSeconds != null && expSeconds > 0 ? expSeconds * 1000 : null
  } catch {
    return null
  }
}

/** Decode a base64url segment (JWT payload) to a string. `atob` is available in
 * both the Tauri renderer and the Node/jsdom test envs. */
function base64UrlToString(segment: string): string {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/")
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")
  return atob(padded)
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
