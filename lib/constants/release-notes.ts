/**
 * Curated, offline-capable "What's new" feed rendered by the About page's
 * `whats-new-card.tsx`. Facts (version + date) live here; the human-readable
 * highlight text is translated via i18n keys `settings.about.whatsNew.highlights.<key>`
 * so the feed stays localisable and offline.
 *
 * Newest release first. Keep highlight keys stable once shipped (they are
 * referenced from `i18n/messages/*.json`).
 */

export interface ReleaseNote {
  /** Semver version string (matches a tagged release). */
  version: string
  /** ISO-8601 release date (YYYY-MM-DD). */
  date: string
  /** i18n highlight keys under `settings.about.whatsNew.highlights`. */
  highlightKeys: string[]
}

export const RELEASES: ReleaseNote[] = [
  {
    version: "0.1.0",
    date: "2026-05-30",
    highlightKeys: ["foundation", "claudeCodeClient", "crossPlatform", "pluginSystem"],
  },
]
