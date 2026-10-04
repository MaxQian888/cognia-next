/**
 * Whether a profile has answered the official account's sign-in screen
 * (ADR-0215 §2).
 *
 * The official account is offered once per profile, new or existing: the
 * gate shows its sign-in screen on the first launch after it became
 * available, and the person either signs in or continues offline. Both
 * answers are kept for good, per profile, so the screen never comes back on
 * its own; signing in later, or again after signing out, starts from
 * Settings → Account. Until the person answers (the app closed on the screen),
 * it is offered again.
 *
 * A self-hosted deployment does not use this: its gate keeps asking, because
 * an organization that runs its own deployment wants its people signed in.
 */

export const OFFICIAL_PROMPT_KEY_PREFIX = "cognia.official-sign-in.decision"

/** `offline`: chose to continue without an account. `signed-in`: signed in from the screen. */
export type OfficialPromptDecision = "offline" | "signed-in"

function key(localAccountId: string): string {
  return `${OFFICIAL_PROMPT_KEY_PREFIX}.${localAccountId}`
}

export function readOfficialPromptDecision(localAccountId: string): OfficialPromptDecision | null {
  try {
    const value = localStorage.getItem(key(localAccountId))
    return value === "offline" || value === "signed-in" ? value : null
  } catch {
    return null
  }
}

/** Whether the gate should still offer the official account to this profile. */
export function shouldOfferOfficialSignIn(localAccountId: string): boolean {
  return readOfficialPromptDecision(localAccountId) === null
}

export function recordOfficialPromptDecision(
  localAccountId: string,
  decision: OfficialPromptDecision
): void {
  try {
    localStorage.setItem(key(localAccountId), decision)
  } catch {
    // A profile that cannot remember is offered the screen again. Acceptable.
  }
}

/** Forget the answer, e.g. when the profile itself is deleted. */
export function forgetOfficialPromptDecision(localAccountId: string): void {
  try {
    localStorage.removeItem(key(localAccountId))
  } catch {
    // Nothing to forget.
  }
}
