import type { AppSettings } from "@cognia/agent-config-types"
import { isOnboardingSettled } from "@cognia/agent-config-types"

/**
 * Decide whether this device should be routed into the first-run flow
 * (ADR-0122). Consumed by `components/providers/onboarding-gate.tsx`.
 *
 * Deliberately synchronous and dependency-free. Its predecessor
 * (`should-show.ts`) awaited a per-provider subscription IPC probe, which put
 * three round-trips on the boot path for a question that is no longer relevant
 * to *whether* to onboard: having an API key configured never meant the user
 * had seen the product do anything. Provider configuration now decides which
 * *steps* appear — the scan step skips the provider step when it finds usable
 * credentials or a usable runtime — so the gate itself does not need to know.
 *
 * Returns `true` only when both hold:
 *   - onboarding is not settled on this device (neither completed nor skipped,
 *     and not migrated from the legacy dismissal stamp), and
 *   - the user has no chat sessions.
 *
 * The session check is what protects a long-time user whose settings row
 * predates this feature entirely: they have conversations, so they are
 * self-evidently onboarded even though they carry no progress record.
 *
 * @param settings   Hydrated settings. Callers must not pass a partial blob —
 *                   an un-hydrated read looks identical to a fresh install.
 * @param sessionsCount Number of chat sessions known to this device.
 */
export function shouldEnterOnboarding(settings: AppSettings, sessionsCount: number): boolean {
  if (isOnboardingSettled(settings.onboardingProgress)) return false
  // Pre-migration read: `migrateLegacyOnboarding` may not have run yet on this
  // boot, and a legacy user must never flash the flow while it does.
  if (settings.onboardingDismissedAt) return false
  if (sessionsCount > 0) return false
  return true
}

/**
 * Whether the residual "finish setup" bar should render after the user landed
 * back in the app.
 *
 * Shown only for a *deliberate* early exit — the paths where something the
 * user wanted is still missing. `completed` has nothing left to finish, and
 * `legacy_dismissed` is pre-dismissed by the migration precisely so upgrading
 * users are not nagged about a flow they never opted into.
 */
export function shouldShowFinishBar(settings: AppSettings): boolean {
  const progress = settings.onboardingProgress
  if (!progress) return false
  if (progress.finishBarDismissed) return false
  return (
    progress.path === "provider_skipped" ||
    progress.path === "runtime_skipped" ||
    progress.path === "task_failed"
  )
}
