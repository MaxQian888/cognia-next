import type { OnboardingIntent, OnboardingShell } from "@cognia/agent-config-types"
import type { OnboardingCapability } from "./scan"

/**
 * The three fixed starter cards that carry the flow to its terminal state: one
 * real, locally-verifiable piece of work (ADR-0122, decision 1).
 *
 * Every card obeys four constraints, and a card that breaks any one of them
 * does not belong here:
 *
 *  1. **No extra authorization.** Nothing that needs a permission grant mid-
 *     flow — a consent dialog on the first run is a wall, not a demo.
 *  2. **Works offline** apart from the model call itself.
 *  3. **Eyeball-verifiable.** The user can judge the result without trusting us.
 *  4. **Under ~30 seconds.**
 *
 * They deliberately show what Cognia has that a plain chat app does not —
 * filesystem, OCR, web reader — rather than what is easiest to build.
 *
 * The card the user picks *is* the personalization signal; there is no
 * questionnaire (decision 16). Multica asks role and use-case on their own
 * screen, but half that design exists to feed PostHog attribution, and Cognia
 * has no analytics backend for that half to pay for. A behavioural signal also
 * beats a self-reported one.
 *
 * `messageKey` names the fixed prompt the card sends. The built-in
 * `cognia-onboarding` skill matches on these, so the two must move together.
 */
export interface StarterCard {
  id: OnboardingIntent
  /** Capabilities that must be confirmed present before the card is offered. */
  requires: readonly OnboardingCapability[]
  /** i18n key suffix under `onboarding.cards.*`. */
  key: string
  icon: "folder" | "scan-text" | "globe"
}

export const STARTER_CARDS: readonly StarterCard[] = [
  { id: "read-folder", requires: ["fs"], key: "readFolder", icon: "folder" },
  { id: "extract-text", requires: ["ocr"], key: "extractText", icon: "scan-text" },
  // The only card with no local requirement, and therefore the only one a
  // paired phone can offer (decision 12): its capabilities live on the desktop
  // it pairs with, and Cognia has no channel that reports them — the companion
  // handshake's `capabilities` are authorization scopes (`host.admin`,
  // `agent.worker`), not feature flags. Building that channel is a separate
  // change; it is not on this flow's critical path.
  { id: "summarize-web", requires: [], key: "summarizeWeb", icon: "globe" },
] as const

/**
 * The cards this device can actually offer.
 *
 * A card whose capability was not confirmed is **hidden, not disabled**. The
 * old tour's failure mode was pitching six subsystems without checking whether
 * any of them were usable; a greyed-out card would reproduce that — it still
 * advertises something the user cannot do, and now also looks broken.
 */
export function availableStarterCards(input: {
  shell: OnboardingShell
  capabilities: readonly OnboardingCapability[]
}): StarterCard[] {
  const present = new Set(input.capabilities)
  return STARTER_CARDS.filter((card) => card.requires.every((c) => present.has(c)))
}

/**
 * Guarantee the flow always has a terminal action.
 *
 * If capability probing turned up nothing — an unusual machine, a probe that
 * timed out, a shell we cannot inspect — we still offer the requirement-free
 * card rather than showing an empty step. Reaching the first-run step with no
 * cards would strand the user one screen short of the entire point of the flow.
 */
export function starterCardsWithFallback(input: {
  shell: OnboardingShell
  capabilities: readonly OnboardingCapability[]
}): StarterCard[] {
  const available = availableStarterCards(input)
  if (available.length > 0) return available
  return STARTER_CARDS.filter((card) => card.requires.length === 0)
}
