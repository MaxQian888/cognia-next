// "Your pet is switched off" — the answer a pet shortcut gets while the pet is
// disabled.
//
// The nurture commands (`pet.feed`, `pet.play`, …) stay registered on the main
// desktop window whether or not the pet is on, so a global chord the user bound
// to one is never reserved at the OS level yet dispatching to nothing. With the
// pet off the access gate refuses the interaction; this turns that refusal into
// something the user can see. A chord usually fires while Cognia is in the
// background, and a disabled pet has no widget or overlay to hold a bubble, so
// the answer goes to the notification center (ADR-0042) instead.
//
// Strings come from the calling React component (which has `useTranslations`);
// this module stays i18n-free, like `lib/pet/care/notify-care.ts`. The center
// applies DND / quiet hours itself, and the `dedupeKey` folds repeated presses
// into one row rather than a stack.

/** Already-localized notification copy supplied by the caller. */
export interface PetUnavailableNotifyStrings {
  title: string
  body?: string
}

/** Injectable notify (defaults to the real runtime; tests pass a spy). */
export interface PetUnavailableNotifyDeps {
  notify?: (input: {
    source: "system"
    level: "info"
    title: string
    body?: string
    dedupeKey: string
    href: string
    icon: string
    directed: boolean
    ttlMs: number
  }) => Promise<string>
}

/** One row however many times the shortcut is pressed. */
export const PET_UNAVAILABLE_DEDUPE_KEY = "pet-interaction-unavailable"

/** Where the pet is switched back on. */
export const PET_UNAVAILABLE_HREF = "/settings?section=pet"

/** Long enough to notice, short enough not to linger after the fact. */
export const PET_UNAVAILABLE_TTL_MS = 5 * 60_000

/**
 * Tell the user a pet shortcut did nothing because the pet is switched off.
 * Never throws: a failed notification must not turn a key press into an error.
 */
export async function notifyPetInteractionUnavailable(
  strings: PetUnavailableNotifyStrings,
  deps: PetUnavailableNotifyDeps = {}
): Promise<boolean> {
  try {
    const notify = deps.notify ?? (await import("@/lib/notifications/runtime")).notify
    await notify({
      source: "system",
      level: "info",
      title: strings.title,
      body: strings.body,
      dedupeKey: PET_UNAVAILABLE_DEDUPE_KEY,
      href: PET_UNAVAILABLE_HREF,
      icon: "PawPrint",
      // An explanation, not a request for action: a dot, not the red badge.
      directed: false,
      ttlMs: PET_UNAVAILABLE_TTL_MS,
    })
    return true
  } catch {
    return false
  }
}
