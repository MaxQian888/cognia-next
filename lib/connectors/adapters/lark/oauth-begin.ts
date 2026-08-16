/**
 * Brain half of the Lark send-as-user OAuth flow — the authorize step.
 *
 * The flow is driven end to end by the brain (ADR-0059 host parity): this
 * module mints the `state` + PKCE verifier and persists them, and
 * `oauth-handler.ts` spends them when the relay hands the code back. Both run
 * in the same process on both hosts, which is the whole point — the previous
 * split (verifier minted in the settings dialog's `localStorage`, code
 * exchanged in the brain) worked on the desktop only because there the two
 * are the same WebView, and could never work on a self-hosted install.
 *
 * Callers:
 *   - the settings dialog, in-process on the desktop;
 *   - the `oauth-begin` operator intent (`cognia-agent lark authorize`), which
 *     is how a headless deployment authorizes without a UI.
 *
 * It returns a URL rather than opening one: only the caller knows whether a
 * browser is reachable from where it runs.
 */

import { connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import { computeCodeChallenge, generateCodeVerifier } from "./pkce"
import { buildLarkOAuthState } from "./oauth-handler"
import { buildLarkOAuthUrl, LARK_SENDAS_SCOPES } from "./auth"
import { setLarkOAuthPending } from "./oauth-pending"

export interface BeginLarkOAuthInput {
  adapterId: string
  /**
   * Exact `redirect_uri` to register with Feishu — normally
   * `{ingressBase}{LARK_OAUTH_RELAY_PATH}`. Required: the value has to match
   * the developer console byte for byte, so guessing it here would only move
   * the failure to a place with less context.
   */
  redirectUri: string
}

export interface BeginLarkOAuthResult {
  /** Open this to authorize. Carries the challenge, never the verifier. */
  authorizeUrl: string
  /** `lark:<adapterId>:<nonce>` — the caller mirrors it for its CSRF check. */
  state: string
  /** The redirect that must be registered in the Feishu console. */
  redirectUri: string
}

export interface BeginLarkOAuthDependencies {
  keyringGet: typeof connectorsKeyringGet
  setPending: typeof setLarkOAuthPending
  makeVerifier: typeof generateCodeVerifier
  makeNonce: () => string
}

/** Absolute http(s) with a host — the shape Feishu's console accepts. */
function isUsableRedirect(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname.length > 0
  } catch {
    return false
  }
}

/**
 * Start an authorization. Throws a short stable reason on operator error
 * (`adapter_id_required`, `redirect_uri_invalid`, `app_id_missing`) so both
 * the CLI and the dialog can map it without parsing prose.
 */
export async function beginLarkOAuth(
  input: BeginLarkOAuthInput,
  overrides: Partial<BeginLarkOAuthDependencies> = {}
): Promise<BeginLarkOAuthResult> {
  const deps: BeginLarkOAuthDependencies = {
    keyringGet: connectorsKeyringGet,
    setPending: setLarkOAuthPending,
    makeVerifier: generateCodeVerifier,
    makeNonce: () => crypto.randomUUID().replace(/-/g, "").slice(0, 16),
    ...overrides,
  }

  const adapterId = input.adapterId.trim()
  if (!adapterId) throw new Error("adapter_id_required")
  const redirectUri = input.redirectUri.trim()
  if (!isUsableRedirect(redirectUri)) throw new Error("redirect_uri_invalid")

  const appId = ((await deps.keyringGet(adapterId, "appId")) ?? "").trim()
  if (!appId) throw new Error("app_id_missing")

  const state = buildLarkOAuthState(adapterId, deps.makeNonce())
  const codeVerifier = deps.makeVerifier()
  const codeChallenge = await computeCodeChallenge(codeVerifier)

  // Persist BEFORE handing out the URL. If the store write fails the caller
  // must not get an authorize link whose code can never be exchanged.
  await deps.setPending(adapterId, { state, codeVerifier, redirectUri })

  return {
    authorizeUrl: buildLarkOAuthUrl({
      appId,
      redirectUri,
      state,
      scope: LARK_SENDAS_SCOPES,
      codeChallenge,
    }),
    state,
    redirectUri,
  }
}
