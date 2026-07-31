/**
 * Search provider connection testing utility
 *
 * cognia-next is a static-export Next.js + Tauri app, so there's no
 * `/api/search/test-connection` route. Instead, we call the per-provider
 * test functions directly. The function shape matches Cognia's so settings
 * UI components compile unchanged.
 */

import type { SearchProviderSettings, SearchProviderType } from "./types"
import { testProviderConnection as testProviderConnectionDirect } from "./search-service"

export async function testProviderConnection(
  provider: SearchProviderType,
  apiKey: string,
  providerSettings?: Partial<SearchProviderSettings>
): Promise<boolean> {
  return testProviderConnectionDirect(provider, apiKey, providerSettings)
}
