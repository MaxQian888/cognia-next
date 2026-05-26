/**
 * Single source of truth for the outbound URLs the app links to.
 *
 * These were previously hand-declared per call site (the docs link lived
 * as a local const in `app/me/help/page.tsx`). Centralising them keeps the
 * mobile help row, the pair-page troubleshooting helper, and any future
 * surface pointing at the same place.
 */

/** Public Fumadocs documentation site. */
export const DOCS_URL = "https://docs.cognia.app"

/** Public source repository. */
export const GITHUB_URL = "https://github.com/anthropics/claude-code"

/**
 * Deep link to the "connect your phone to the desktop" guide. Used by the
 * mobile pair flow's troubleshooting helper. The `/docs` segment + locale
 * are resolved by the docs site router; the getting-started page documents
 * enabling the companion server and same-network requirements.
 */
export const DOCS_COMPANION_SETUP_URL = `${DOCS_URL}/docs/en/getting-started`
