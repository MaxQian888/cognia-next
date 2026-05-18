/**
 * Helper for codex specs that drive the "Reuse codex-cli" adopt flow without
 * touching the real `~/.codex/auth.json`. The renderer-side `discoverCodexAuth`
 * consults `window.__cogniaE2ECodexDiscovery` first; specs publish a
 * synthetic discovery payload through this helper.
 *
 * Set to `null` to exercise the "no credential found" branch; pass a partial
 * payload to drive the "credential present but not adoptable" branch.
 */

import { type Page } from "@playwright/test"
import { waitForTestGlobals } from "./db-reset"

export interface MockCodexDiscoveryTokens {
  accessToken: string
  refreshToken: string
  idTokenRaw: string
  email?: string
  chatgptPlanType?: string
  chatgptUserId?: string
  accountId?: string
  chatgptAccountId?: string
}

export interface MockCodexDiscovery {
  source: "file" | "keyring"
  authJsonPath: string
  authMode?: string
  openaiApiKey?: string
  tokens?: MockCodexDiscoveryTokens
  lastRefreshIso?: string
}

export async function setCodexDiscoveryOverride(
  page: Page,
  override: MockCodexDiscovery | null | undefined
): Promise<void> {
  await waitForTestGlobals(page)
  await page.evaluate((next) => {
    const w = window as { __cogniaE2ECodexDiscovery?: unknown }
    if (next === undefined) {
      delete w.__cogniaE2ECodexDiscovery
    } else {
      w.__cogniaE2ECodexDiscovery = next
    }
  }, override)
}
