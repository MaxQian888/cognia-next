// Frontend wrapper around the `codex_sub_discover` Tauri command. Used by
// the "Reuse" mode of the Codex login dialog and by env-builder when our own
// keyring is empty but the user has codex-cli already logged in.

import { transport } from "@/lib/tauri"
import type { CodexCredential, DiscoveredCodexAuth, DiscoveredCodexTokens } from "./types"

/**
 * Probe `~/.codex/auth.json` + codex-cli's keyring entry. Returns `null`
 * when no codex-cli credential is present anywhere; the rejected case is
 * reserved for actual parse failures (renderer surfaces as "credential
 * corrupted").
 */
export async function discoverCodexAuth(): Promise<DiscoveredCodexAuth | null> {
  const got = await transport.call<DiscoveredCodexAuth | null>("codex_sub_discover")
  return got ?? null
}

/**
 * Translate a `DiscoveredCodexAuth` into the shape we persist into our own
 * keyring. This is the "Adopt" operation: copy fields verbatim, never
 * mutate codex-cli's source files.
 *
 * Returns `null` when the discovered payload has neither a ChatGPT bearer
 * nor an API key (in which case the renderer should treat it as
 * "credential present but unusable" and stay logged-out).
 */
export function discoveredToCredential(
  discovered: DiscoveredCodexAuth,
  nowMs: number = Date.now()
): CodexCredential | null {
  const stored: Pick<CodexCredential, "originalSource" | "storedAtMs"> = {
    originalSource: discovered.source,
    storedAtMs: nowMs,
  }
  if (discovered.tokens && discovered.tokens.accessToken) {
    return chatGptCredentialFrom(discovered.tokens, stored)
  }
  if (discovered.openaiApiKey) {
    return apiKeyCredentialFrom(discovered.openaiApiKey, stored)
  }
  return null
}

function chatGptCredentialFrom(
  tokens: DiscoveredCodexTokens,
  stored: Pick<CodexCredential, "originalSource" | "storedAtMs">
): CodexCredential {
  // codex-cli's bearer JWTs typically embed a 30-minute `exp` claim; rather
  // than reach into the JWT decoder here (we already parse claims server-side
  // for plan/email), we leave `expiresAtMs` at 0 and rely on the renderer's
  // refresh loop to populate it after the first successful refresh call.
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
  stored: Pick<CodexCredential, "originalSource" | "storedAtMs">
): CodexCredential {
  return {
    accessToken: apiKey,
    refreshToken: "",
    idTokenRaw: "",
    expiresAtMs: 0,
    authMode: "api_key",
    ...stored,
  }
}
