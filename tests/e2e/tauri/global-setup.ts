/**
 * No-op re-export. The suite-level `tests/e2e/global-setup.ts` already
 * handles the tauri-driver boot when PLAYWRIGHT_TAURI_DRIVER=1, so this
 * file exists only to flag the convention: a project-scoped setup *could*
 * live here if we ever needed Tauri-specific bootstrapping outside of the
 * shared mock fleet (e.g., seeding the Tauri app keyring).
 *
 * Don't register this file in playwright.config.ts unless you genuinely
 * need project-scoped logic — duplicating the launch would double-spawn
 * tauri-driver.
 */

export {}
