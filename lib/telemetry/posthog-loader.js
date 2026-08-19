/**
 * Keep PostHog's very large generated declaration graph out of the app-wide
 * TypeScript program while preserving a statically discoverable dynamic chunk.
 * The slim browser build omits optional UI/recording extensions we permanently
 * disable for Cognia's manual-capture integration.
 */
export async function loadPostHogBrowser() {
  const loaded = await import("posthog-js/dist/module.slim.js")
  return loaded.default
}
