/**
 * Single source of truth for the outbound URLs the app links to.
 *
 * These were previously hand-declared per call site (the docs link lived
 * as a local const in `app/me/help/page.tsx`). Centralising them keeps the
 * mobile help row, the About page resources card, the pair-page
 * troubleshooting helper, and any future surface pointing at the same place.
 */

/** Public Fumadocs documentation site. */
export const DOCS_URL = "https://docs.cognia.app"

/** Public source repository (matches `src-tauri/Cargo.toml` `repository`). */
export const GITHUB_URL = "https://github.com/MaxQian888/cognia-next"

/** Issue tracker — used by the About "Report an issue" link. */
export const ISSUES_URL = `${GITHUB_URL}/issues`

/** GitHub Releases — the canonical "what's new" / download history. */
export const RELEASES_URL = `${GITHUB_URL}/releases`

/** Full changelog. We point at the releases page (release notes live there). */
export const CHANGELOG_URL = RELEASES_URL

/**
 * Repository licence page. The repo currently has no root `LICENSE` file, so
 * this deep-links to where it will live; see `LICENSE_NAME` in
 * `lib/app-metadata.ts` for the displayed licence label.
 */
export const LICENSE_URL = `${GITHUB_URL}/blob/master/LICENSE`

/** Community / discussions hub. */
export const COMMUNITY_URL = `${GITHUB_URL}/discussions`

/** Privacy policy (hosted on the docs site). */
export const PRIVACY_URL = `${DOCS_URL}/docs/en/privacy`

/**
 * Deep link to the "connect your phone to the desktop" guide. Used by the
 * mobile pair flow's troubleshooting helper. The `/docs` segment + locale
 * are resolved by the docs site router; the getting-started page documents
 * enabling the companion server and same-network requirements.
 */
export const DOCS_COMPANION_SETUP_URL = `${DOCS_URL}/docs/en/getting-started`
