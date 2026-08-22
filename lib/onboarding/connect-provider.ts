import { describeConnectedAccount, type ConnectedAccountSummary } from "./connected-account"
import { getBuiltInProviderReadiness } from "@/components/settings/provider/provider-readiness"
import { setActiveAccount } from "@/lib/subscription/core/transport"
import { setProviderDefaultAccount } from "@/lib/subscription/core/account-lifecycle"
import type { Account } from "@/types/subscription"

/**
 * The two ways first-run hands Cognia a credential, in one place.
 *
 * Both paths now have two callers — the step-by-step sign-in step and the
 * recommended screen's inline block — and a credential write that drifts
 * between them is close to undebuggable: the symptom is a first task
 * dispatched to the wrong provider several screens later, with nothing in
 * between to suggest why. Extracting them means "what connecting writes" has
 * exactly one answer, which is the property ADR-0122 was arguing for when it
 * enumerated the three pointers to begin with.
 */

/**
 * The three writes a subscription connection makes, and why each is needed.
 *
 *  1. `setActiveAccount` — the vault's active pointer. On its own it is the
 *     lowest-priority link in the ADR-0028 resolution chain.
 *  2. `setProviderDefaultAccount` — the scoped default that chain actually
 *     falls back to, so a later session or character override has something
 *     to resolve against.
 *  3. `setDefaultProvider` — which dispatcher the turn uses at all. Without
 *     it `build-options` falls through to its literal `"anthropic"`, and a
 *     user who connected ChatGPT had their first run sent to Anthropic.
 *     It also re-syncs `defaultModel`, keeping the pair coherent.
 *
 * Throws on failure rather than swallowing: a half-connected account is worse
 * than an unconnected one, and the caller is the surface that can say so.
 */
export async function connectSubscriptionAccount(input: {
  account: Account
  setDefaultProvider: (providerId: string) => Promise<void>
}): Promise<ConnectedAccountSummary> {
  const summary = describeConnectedAccount(input.account)
  await setActiveAccount(summary.provider, input.account.id)
  await setProviderDefaultAccount(summary.provider, input.account.id)
  await input.setDefaultProvider(summary.provider)
  return summary
}

/** What a BYOK draft needs before it counts as configured. */
export interface BuiltInProviderDraft {
  providerId: string
  /** Empty when the provider needs no credential (a local server). */
  apiKey: string
  /** Empty when the provider has a fixed endpoint. */
  baseURL: string
  requiresCredential: boolean
  requiresBaseUrl: boolean
}

export type SaveKeyResult =
  | { ok: true }
  /** Rejected by the same rules Settings validates against. */
  | { ok: false; reason: "incomplete" }

/** The Anthropic-only legacy slot, still pushed into the Rust `ApiKeyState`. */
const LEGACY_KEY_PROVIDER = "anthropic"

/**
 * Persist a built-in provider's credentials.
 *
 * **Order matters.** `providerSettings[id]` is what the standalone resolver and
 * the ai-sdk dispatch path read, so it is written first: `setDefaultProvider`
 * pushes the sidecar env, and doing that before the key lands pushes a null
 * and restarts twice.
 *
 * **Validated against `getBuiltInProviderReadiness`** — the same rules the
 * Settings page validates against, so a draft first-run accepts is one that
 * page would call configured. A second opinion about what "enough" means per
 * provider is how the two surfaces end up disagreeing.
 *
 * **The legacy slot is only written for Anthropic.** It is read at boot to
 * seed the Rust `ApiKeyState`, so leaving a stale value there would restore it
 * on the next launch — but pushing another provider's key into an
 * Anthropic-shaped env slot is a silent mix-up, not a compatibility measure.
 */
export async function saveBuiltInProviderKey(input: {
  draft: BuiltInProviderDraft
  setProviderConfig: (providerId: string, patch: Record<string, unknown>) => Promise<void>
  setDefaultProvider: (providerId: string) => Promise<void>
  setApiKey: (key: string) => Promise<void>
}): Promise<SaveKeyResult> {
  const { draft } = input
  const apiKey = draft.apiKey.trim()
  const baseURL = draft.baseURL.trim()
  const patch = {
    ...(draft.requiresCredential ? { apiKey } : {}),
    ...(draft.requiresBaseUrl ? { baseURL } : {}),
    enabled: true,
  }

  if (getBuiltInProviderReadiness(draft.providerId, patch).readiness === "unconfigured") {
    return { ok: false, reason: "incomplete" }
  }

  await input.setProviderConfig(draft.providerId, patch)
  await input.setDefaultProvider(draft.providerId)
  if (draft.providerId === LEGACY_KEY_PROVIDER) await input.setApiKey(apiKey)
  return { ok: true }
}
