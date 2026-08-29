/**
 * Freeze a conversation's sandbox tier onto the session the first time it
 * actually binds one.
 *
 * The tier ladder (`session → character → appSettings → "os"`, resolved by
 * {@link resolveSandboxSessionBinding}) is re-read on EVERY send. Nothing
 * writes `ChatSession.sandboxTier` — no UI control does, only the character
 * editor and the app-settings card write a tier — so in practice every session
 * inherits, and changing `AppSettings.sandboxTier` retroactively re-tiers every
 * existing conversation. A conversation that ran ten turns inside a microVM
 * silently continues on the host, and the only signal is the composer shield
 * quietly changing glyph.
 *
 * That contradicts the rule `lib/sandbox/binding.ts` already states for the
 * connection axis — "a violation is a refusal, never a downgrade … the user
 * asked for isolation and would not be told they lost it".
 *
 * The fix is to pin rather than to refuse. Refusing would make sends start
 * failing because of a settings change the user made deliberately somewhere
 * else, and the existing refusal path (`bindUnplacedSession` →
 * `placement-unavailable`) would report it as a *placement* problem, which it
 * is not. Pinning keeps isolation from decreasing without breaking a send.
 *
 * A pin with no way out would be worse than the drift, so the composer shield
 * owns the un-pin: it clears `session.sandboxTier` AND sets
 * `session.sandboxTierFollowsDefault`, which this refuses to pin over. The flag
 * is what makes the release durable — clearing the tier alone left the session
 * looking exactly like one that had never been pinned, so the next send pinned
 * it straight back and the button appeared to do nothing.
 */

import type { SandboxShellTier } from "@/types/sandbox"
import type { SandboxBindingInputs, SandboxTierSource } from "@/lib/sandbox/binding"
import { resolveSandboxSessionBinding, resolveSandboxTierSource } from "@/lib/sandbox/binding"

export interface SessionTierPinDecision {
  /** Whether the resolved tier should be written onto the session. */
  pin: boolean
  /** The tier the ladder resolved to, whether or not it is being pinned. */
  tier: SandboxShellTier
  /** Which rung supplied it. */
  source: SandboxTierSource
}

/**
 * Decide whether this send should freeze the tier onto the session.
 *
 * Pure. Pins only when the session is about to run sandboxed AND the tier came
 * from a layer beneath the session AND the conversation has not been explicitly
 * released — a tier already stored on the session is the user's own answer and
 * is never rewritten, a session that is not sandboxed has no isolation to lose,
 * and a session someone told to follow the default is one whose answer is "keep
 * following it".
 */
export function decideSessionTierPin(args: {
  sandboxEnabled: boolean
  /** `ChatSession.sandboxTierFollowsDefault` — the explicit release. */
  followsDefault?: boolean
  inputs: SandboxBindingInputs
}): SessionTierPinDecision {
  const tier = resolveSandboxSessionBinding(args.inputs).shellTier
  const source = resolveSandboxTierSource(args.inputs)
  return {
    pin: args.sandboxEnabled && source !== "session" && !args.followsDefault,
    tier,
    source,
  }
}
