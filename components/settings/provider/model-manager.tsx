"use client"

/**
 * Backward-compatible entry point for local model management.
 *
 * The provider system now manages local runtimes through the shared Rust HTTP
 * proxy and `LocalProviderSettings`; keeping a second native-download surface
 * would split state and reintroduce the renderer/CSP failures fixed by
 * ADR-0076.
 */

import { LocalProviderSettings } from "./local-provider-settings"

export function ModelManager() {
  return <LocalProviderSettings />
}

export default ModelManager
