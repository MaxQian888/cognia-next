import type { AppSettings } from "@cognia/agent-config-types"
import { ALL_PROVIDER_IDS } from "@/types/subscription"
import { getActiveAccount } from "@/lib/subscription/core/transport"
import { loggers } from "@cognia/logging"

const log = loggers.ui

/**
 * Decide whether the desktop first-run onboarding dialog should appear.
 *
 * The predicate replaces the inline `!apiKey && !dismissed && sessions===0`
 * check that used to live in `desktop-chat-workspace.tsx` and
 * `app-shell-mobile.tsx`. It widens "configured" beyond `apiKey`-only to
 * include any active ADR-0025 subscription account, so users who finished
 * Claude/Codex/OpenCode OAuth never see the modal again.
 *
 * Returns `true` only when *all* of the following hold:
 *   - the user has zero chat sessions
 *   - `onboardingDismissedAt` has never been set
 *   - no direct `apiKey` is stored
 *   - no provider has an active subscription account
 *
 * Any IPC failure while probing subscription state is treated as
 * "no active account" so a failing subscription init never traps a fresh
 * install in a state where onboarding is unreachable.
 */
export async function shouldShowOnboarding(
  settings: AppSettings,
  sessionsCount: number
): Promise<boolean> {
  if (sessionsCount > 0) return false
  if (settings.onboardingDismissedAt) return false
  if (settings.apiKey) return false

  for (const provider of ALL_PROVIDER_IDS) {
    try {
      const snapshot = await getActiveAccount(provider)
      if (snapshot.activeAccountId) return false
    } catch (err) {
      log.debug("onboarding probe failed", { provider, error: String(err) })
    }
  }
  return true
}
