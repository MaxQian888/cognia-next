import type { AppSettings, OnboardingProgress } from "@cognia/agent-config-types"
import { ONBOARDING_STATE_VERSION } from "@cognia/agent-config-types"

/**
 * One-way projection of the pre-ADR-0122 `onboardingDismissedAt` timestamp
 * onto the structured {@link OnboardingProgress} record.
 *
 * The old field was written on *every* exit path of the legacy dialog — skip,
 * OAuth success, character pick, tour finish, Esc, click-outside — so its true
 * intent is unrecoverable. We deliberately do not guess: the migrated record
 * carries `path: "legacy_dismissed"`, which `shouldEnterOnboarding` treats as
 * settled. Existing users are never re-prompted; Settings offers a re-run for
 * anyone who wants one.
 *
 * `skippedAt` (rather than `completedAt`) is the honest stamp — we know they
 * left the old flow, not that they finished it. The distinction matters for
 * the residual "finish setup" bar, which reads `path` to decide its copy.
 *
 * Pure and idempotent: it returns `null` when there is nothing to migrate
 * (already structured, or a genuinely fresh install), so callers can run it on
 * every boot without churning the settings row.
 */
export function migrateLegacyOnboarding(settings: AppSettings): OnboardingProgress | null {
  if (settings.onboardingProgress) return null
  if (!settings.onboardingDismissedAt) return null
  return {
    version: ONBOARDING_STATE_VERSION,
    path: "legacy_dismissed",
    skippedAt: settings.onboardingDismissedAt,
    // No `lastStep`: the legacy dialog's steps do not map onto the new flow,
    // so a re-run from Settings starts at the beginning rather than dropping
    // the user into a step chosen from stale information.
    //
    // The bar is pre-dismissed: these users never opted into the new flow, and
    // a persistent "finish setup" nag is exactly the re-prompt this migration
    // exists to avoid.
    finishBarDismissed: true,
  }
}
