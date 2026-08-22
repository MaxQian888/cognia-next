/**
 * Brain half of the Slack OAuth v2 flow — the authorize step.
 *
 * Mirrors `adapters/lark/oauth-begin.ts` deliberately: the flow is driven end
 * to end by the brain (ADR-0059 host parity), this module mints the `state` and
 * persists it, and `oauth-handler.ts` spends it when the relay hands the code
 * back. Both run in the same process on both hosts.
 *
 * The previous shape could never work. The settings dialog minted a bare
 * `crypto.randomUUID()`, stored it under its own `sessionStorage` key, and
 * pointed Slack at `cognia://connector/oauth/slack` — while the completion
 * handler expected `slack:<adapterId>:<nonce>`, the deep-link router read a
 * different storage key, and Slack refuses to register a custom scheme as a
 * redirect URL at all. Three independent mismatches, so the flow ended at the
 * router's state check every single time.
 *
 * Callers:
 *   - the settings dialog, in-process on the desktop;
 *   - the `oauth-begin` operator intent (`cognia-agent lark authorize`, which
 *     dispatches on the adapter's own type), which is how a headless
 *     deployment authorizes without a UI.
 *
 * It returns a URL rather than opening one: only the caller knows whether a
 * browser is reachable from where it runs.
 */

import { connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import { buildSlackOAuthState } from "./oauth-handler"
import { buildSlackOAuthUrl } from "./oauth"
import { setSlackOAuthPending } from "./oauth-pending"

/**
 * Bot scopes the adapter needs to read a channel and answer in it.
 *
 * Lives here rather than in the dialog because the headless authorize path has
 * no dialog, and the two must not drift — Slack pins the granted scopes to the
 * token at exchange time, so a mismatch is only discovered later as a runtime
 * `missing_scope`.
 */
export const SLACK_BOT_SCOPES = [
  "chat:write",
  "channels:history",
  "im:history",
  "app_mentions:read",
  // The adapter implements uploads, reactions and pins, and SLACK_CAPS
  // advertises all three — but this list asked for none of their scopes, so
  // every OAuth install advertised capabilities that answered `missing_scope`
  // at delivery. `lib/connectors/effective-capabilities.ts` now hides them for
  // a grant that lacks the scope; requesting the scope is the other half, so
  // the capability is real rather than merely hidden.
  "files:write",
  "reactions:write",
  "pins:write",
  // Deliberately NOT requested: `groups:history` / `mpim:history`. They would
  // extend history reads into private channels and group DMs — a widening of
  // what the bot can read, not a fix for something it already claims. The
  // capability projection accepts either if an operator grants it by hand.
] as const

export interface BeginSlackOAuthInput {
  adapterId: string
  /**
   * Exact `redirect_uri` to register with Slack — normally
   * `{ingressBase}{connectorOAuthRelayPath("slack")}`. Required: the value has
   * to match the Slack app's "Redirect URLs" entry byte for byte, so guessing
   * it here would only move the failure somewhere with less context.
   */
  redirectUri: string
}

export interface BeginSlackOAuthResult {
  /** Open this to authorize. */
  authorizeUrl: string
  /** `slack:<adapterId>:<nonce>` — the caller mirrors it for its CSRF check. */
  state: string
  /** The redirect that must be registered in the Slack app config. */
  redirectUri: string
}

export interface BeginSlackOAuthDependencies {
  keyringGet: typeof connectorsKeyringGet
  setPending: typeof setSlackOAuthPending
  makeNonce: () => string
}

/** Absolute https with a host — the shape Slack's console accepts. */
function isUsableRedirect(value: string): boolean {
  try {
    const url = new URL(value)
    // Slack requires TLS on redirect URLs; http would be rejected at authorize
    // time with `bad_redirect_uri`, which reads like a typo rather than a
    // scheme problem.
    return url.protocol === "https:" && url.hostname.length > 0
  } catch {
    return false
  }
}

/**
 * Start an authorization. Throws a short stable reason on operator error
 * (`adapter_id_required`, `redirect_uri_invalid`, `client_id_missing`) so both
 * the CLI and the dialog can map it without parsing prose.
 */
export async function beginSlackOAuth(
  input: BeginSlackOAuthInput,
  overrides: Partial<BeginSlackOAuthDependencies> = {}
): Promise<BeginSlackOAuthResult> {
  const deps: BeginSlackOAuthDependencies = {
    keyringGet: connectorsKeyringGet,
    setPending: setSlackOAuthPending,
    makeNonce: () => crypto.randomUUID().replace(/-/g, "").slice(0, 16),
    ...overrides,
  }

  const adapterId = input.adapterId.trim()
  if (!adapterId) throw new Error("adapter_id_required")
  const redirectUri = input.redirectUri.trim()
  if (!isUsableRedirect(redirectUri)) throw new Error("redirect_uri_invalid")

  const clientId = ((await deps.keyringGet(adapterId, "clientId")) ?? "").trim()
  if (!clientId) throw new Error("client_id_missing")

  const state = buildSlackOAuthState(adapterId, deps.makeNonce())

  // Persist BEFORE handing out the URL. If the store write fails the caller
  // must not get an authorize link whose code can never be exchanged.
  await deps.setPending(adapterId, { state, redirectUri })

  return {
    authorizeUrl: buildSlackOAuthUrl({
      clientId,
      scopes: [...SLACK_BOT_SCOPES],
      redirectUri,
      state,
    }),
    state,
    redirectUri,
  }
}
