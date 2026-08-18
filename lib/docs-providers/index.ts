/**
 * Remote document providers — public barrel and built-in registration.
 *
 * Importing this module registers the built-ins, so anything that reads the
 * registry (`components/chat/composer-trigger.ts`, the picker, the settings
 * cards) must import from here rather than from `./registry` directly.
 */

import { __clearDocsProvidersForTests, registerDocsProvider } from "./registry"
import { larkDocsProvider } from "./providers/lark"
import { googleDocsProvider } from "./providers/google"

export * from "./types"
export * from "./registry"
export { clampDocText, truncationMarker } from "./limits"
export * from "./oauth-deep-link"
export { larkDocsProvider } from "./providers/lark"
export { googleDocsProvider } from "./providers/google"

function registerBuiltinDocsProviders(): void {
  registerDocsProvider(larkDocsProvider)
  registerDocsProvider(googleDocsProvider)
}

/** Test-only: restore the registry to exactly the built-in set. */
export function __resetDocsProvidersForTests(): void {
  __clearDocsProvidersForTests()
  registerBuiltinDocsProviders()
}

registerBuiltinDocsProviders()
