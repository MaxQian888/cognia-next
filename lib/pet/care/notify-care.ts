// Bridge between the care condition and the unified notification center
// (ADR-0042). Strings are passed in by the calling React hook (which has
// `useTranslations`); this module stays i18n-free — mirrors
// `lib/webdav/remote-newer-notify.ts`.
//
// The center governs DND / quiet hours through notification preferences, so we
// don't re-implement that here; the `dedupeKey` coalesces re-entries (e.g. the
// widget mounted in two windows) into a single durable record.

/** Already-localized notification copy supplied by the caller. */
export interface CareNotifyStrings {
  title: string
  body?: string
}

/** Injectable notify (defaults to the real runtime; tests pass a spy). */
export interface CareNotifyDeps {
  notify?: (input: {
    source: "system"
    level: "info"
    title: string
    body?: string
    dedupeKey: string
    icon: string
    directed: boolean
  }) => Promise<string>
}

/** Stable dedupe key — one care record per unwell episode (until recovery). */
export const CARE_UNWELL_DEDUPE_KEY = "pet-care-unwell"

/**
 * Post a gentle "your pet isn't feeling great" notification. Never throws —
 * background care alerts must not disrupt the caller.
 */
export async function notifyBecameUnwell(
  strings: CareNotifyStrings,
  deps: CareNotifyDeps = {}
): Promise<boolean> {
  try {
    const notify = deps.notify ?? (await import("@/lib/notifications/runtime")).notify
    await notify({
      source: "system",
      level: "info",
      title: strings.title,
      body: strings.body,
      dedupeKey: CARE_UNWELL_DEDUPE_KEY,
      icon: "Heart",
      directed: true,
    })
    return true
  } catch {
    return false
  }
}
