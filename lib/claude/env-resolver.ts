// ADR-0028 — per-`query()` env injection: resolve the env tuple for the
// account that will serve this turn.
//
// `resolveSendOptions` consumes both and merges them into `opts.env` ahead of
// other env layers (e.g. `debugMode`). The dispatch chain on the sidecar side
// (`sidecar/dispatch/anthropic.mjs:117`) then spreads them onto
// `{ ...process.env, ...sendOptions.env }` so the spawned CLI subprocess
// inherits the right OAuth identity, `CLAUDE_CONFIG_DIR`, base URL, and proxy
// for this specific session — without flipping the global `ActiveAccountState`
// pointer.

import { transport } from "@/lib/tauri"
import { isStandaloneChatMode } from "@/lib/runtime/standalone-mode"
import { getActiveAccount } from "@/lib/subscription/core/transport"
import { useAccountStore } from "@/stores/account/account-store"
import type {
  AppSettings,
  Character,
  ChatSession,
  SubscriptionAccountProvider,
} from "@cognia/agent-config-types"

export function subscriptionAccountProviderFor(
  providerId: string
): SubscriptionAccountProvider | null {
  if (providerId === "anthropic" || providerId === "codex" || providerId === "opencode") {
    return providerId
  }
  if (providerId === "opencode-go") return "opencode"
  return null
}

export class SubscriptionAccountResolutionError extends Error {
  override readonly name = "SubscriptionAccountResolutionError"

  constructor(
    readonly providerId: string,
    readonly accountId: string,
    message: string,
    readonly cause?: unknown
  ) {
    super(message)
  }
}

/**
 * Walk the ADR-0028 precedence chain to pick the accountId for this turn:
 *
 *   session.accountId
 *     ?? character.accountIdOverride
 *     ?? settings.defaultAccountIds[providerId]
 *     ?? null
 *
 * A `null` result tells the environment resolver to validate and use the
 * provider's active pointer. Pure: no I/O.
 */
export function resolveAccountId(
  providerId: string,
  session: ChatSession | null | undefined,
  character: Character | null | undefined,
  settings: AppSettings | null | undefined
): string | null {
  if (session?.accountId) return session.accountId
  if (character?.accountIdOverride) return character.accountIdOverride
  const scopedProvider = subscriptionAccountProviderFor(providerId)
  if (scopedProvider) {
    const scopedDefault = settings?.defaultAccountIds?.[scopedProvider]
    if (scopedDefault) return scopedDefault
  }
  if (
    (settings?.defaultProvider === providerId || settings?.defaultProvider === scopedProvider) &&
    settings.defaultAccountId
  ) {
    return settings.defaultAccountId
  }
  return null
}

/**
 * Fetch the per-account env tuple from the Rust subscription layer
 * (`subscription/active.rs::env_for_account`). The Rust side ensure-creates
 * the per-account `CLAUDE_CONFIG_DIR` directory and returns the OAuth /
 * `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_CUSTOM_HEADER_*`
 * pairs plus `CLAUDE_CONFIG_DIR`.
 *
 * A missing or stale selection is a typed failure. This prevents a send from
 * inheriting a bearer left in the sidecar process or another provider's active
 * projection. Non-subscription providers and standalone mode do not use this
 * account system and return an empty record.
 *
 * Callers merge this on top of `process.env` semantics (the sidecar does the
 * `{ ...process.env, ...env }` spread); duplicate keys make the account env
 * authoritative — exactly the intent.
 */
export async function resolveAccountEnv(
  providerId: string,
  accountId: string | null
): Promise<Record<string, string>> {
  if (isStandaloneChatMode()) return {}
  const scopedProvider = subscriptionAccountProviderFor(providerId)
  if (!scopedProvider) return {}
  const localAccountId = useAccountStore.getState().unlockedAccountId
  if (!localAccountId) {
    throw new SubscriptionAccountResolutionError(
      providerId,
      accountId ?? "",
      "A local account must be unlocked before a provider account can be resolved."
    )
  }
  if (!accountId) {
    try {
      const active = await getActiveAccount(scopedProvider)
      if (!active.activeAccountId) {
        throw new SubscriptionAccountResolutionError(
          providerId,
          "",
          `No active ${providerId} account is available. Add or activate an account in Settings.`
        )
      }
      return Object.fromEntries(active.env)
    } catch (err) {
      if (err instanceof SubscriptionAccountResolutionError) throw err
      throw new SubscriptionAccountResolutionError(
        providerId,
        "",
        `Could not resolve the active ${providerId} account.`,
        err
      )
    }
  }
  try {
    const entries = await transport.call<Array<{ key: string; value: string }> | null>(
      "claude_env_for_account",
      {
        provider: scopedProvider,
        localAccountId,
        accountId,
      }
    )
    if (!entries) {
      throw new SubscriptionAccountResolutionError(
        providerId,
        accountId,
        `Provider account ${accountId} is no longer available for ${providerId}.`
      )
    }
    return Object.fromEntries(entries.map(({ key, value }) => [key, value]))
  } catch (err) {
    if (err instanceof SubscriptionAccountResolutionError) throw err
    console.warn("resolveAccountEnv failed", err)
    throw new SubscriptionAccountResolutionError(
      providerId,
      accountId,
      `Could not resolve provider account ${accountId} for ${providerId}.`,
      err
    )
  }
}

/**
 * Compatibility shim for older callers. Proxy variables are now installed by
 * the Rust host before the sidecar starts, so renderer/session data can never
 * override the process-wide fail-closed policy.
 */
export async function resolveProxyEnv(
  _sessionId: string | null | undefined
): Promise<Record<string, string>> {
  return {}
}

/**
 * The same resolution, downgraded to best effort for a turn that will be
 * dispatched to an EXTERNAL agent runtime.
 *
 * An external turn runs in an agent process that brings its own credentials.
 * Pi, Codex, Gemini CLI and friends each authenticate themselves, and the
 * subscription account is nowhere in that path. Resolving it was still fatal
 * for them, because `resolveSendOptions` runs before the send path picks a
 * lane: a browser or a companion with no active Anthropic account could not
 * send a single turn to a configured external agent, and the failure it showed
 * ("Could not resolve the active anthropic account") named a provider the turn
 * was never going to use.
 *
 * Still ATTEMPTED rather than skipped: a turn whose tool surface collapses to
 * `none` is dispatched on the built-in lane after this point (see
 * `use-claude-chat-controller`'s `manualExternal`), and skipping outright would
 * hand that fallback an empty env when a perfectly good account existed. So the
 * env is resolved when it can be, and its absence stops being a refusal.
 */
export async function resolveAccountEnvForExternalRuntime(
  providerId: string,
  accountId: string | null
): Promise<Record<string, string>> {
  try {
    return await resolveAccountEnv(providerId, accountId)
  } catch (err) {
    if (err instanceof SubscriptionAccountResolutionError) {
      console.warn(
        "resolveAccountEnv skipped for an external-runtime turn",
        providerId,
        err.message
      )
      return {}
    }
    throw err
  }
}
