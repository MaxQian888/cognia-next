// First-run onboarding state (ADR-0122). Persisted as two *top-level*
// `AppSettings` fields — `onboardingProgress` and `onboardingProfile` — rather
// than one nested object, because `SETTINGS_SYNC` classifies one entry per
// top-level key and these two halves must sync differently. Nesting them would
// have silently forced a single classification on both.
//
// The predecessor was a single `onboardingDismissedAt` timestamp, which
// collapsed "finished the flow", "bailed on the first step" and "hit Esc by
// accident" into one indistinguishable value. That field is retained on
// `AppSettings` for one-way migration reads only (see
// `lib/onboarding/migrate-legacy.ts`); nothing writes it any more.

/**
 * Which shell the app is running in. Onboarding steps declare the shells they
 * apply to (`availableIn`), because the four contexts differ in what they can
 * actually do — a local-runtime scan is meaningless on a paired phone, where
 * the compute lives on the desktop.
 */
export type OnboardingShell = "tauri" | "web" | "mobile-standalone" | "mobile-paired"

export const ONBOARDING_SHELLS = [
  "tauri",
  "web",
  "mobile-standalone",
  "mobile-paired",
] as const satisfies readonly OnboardingShell[]

/**
 * Persisted step ids. `welcome` is included here (unlike Multica, which keeps
 * its intro out of the canonical order) because the mobile mode fork lives on
 * it — resuming a mobile user mid-flow has to be able to land back on the
 * screen where they picked standalone vs paired.
 */
export type OnboardingStepId = "welcome" | "scan" | "provider" | "first-run"

/**
 * How the user left the flow. Recorded so the post-onboarding "finish setup"
 * bar can say something specific, and so re-entry knows what is still missing.
 *
 *  - `completed`        — reached a first real output.
 *  - `provider_skipped` — left without any usable model access.
 *  - `runtime_skipped`  — skipped the scan step; no local runtime selected.
 *  - `task_failed`      — picked a starter card but the run errored out.
 *  - `legacy_dismissed` — migrated from the old `onboardingDismissedAt`
 *                         timestamp, whose true intent is unrecoverable. Never
 *                         re-prompts on its own; Settings offers a re-run.
 */
export type OnboardingPath =
  "completed" | "provider_skipped" | "runtime_skipped" | "task_failed" | "legacy_dismissed"

/** Current schema version of {@link OnboardingProgress}. */
export const ONBOARDING_STATE_VERSION = 1

/**
 * Completion bookkeeping. Classified `device-local`: every device legitimately
 * holds its own answer, because a phone's onboarding is substantially the
 * pairing flow. Syncing this would let a desktop completion mark an unpaired
 * phone as onboarded, stranding it in a state that is both "done" and unusable.
 */
export interface OnboardingProgress {
  version: number
  /** Set once the user reached a first real output. */
  completedAt?: string
  /** Set when the user left early. Mutually exclusive with `completedAt`. */
  skippedAt?: string
  /** Where to resume. Absent once `completedAt` is set. */
  lastStep?: OnboardingStepId
  path: OnboardingPath
  /** True once the user closed the residual "finish setup" bar for good. */
  finishBarDismissed?: boolean
}

/**
 * What the user wants out of the product, inferred from which starter card
 * they picked rather than asked in a questionnaire — the card choice is the
 * intent declaration, and a behavioural signal beats a self-reported one.
 *
 * Mirrors the starter-card ids in `lib/onboarding/starter-cards.ts`.
 */
export type OnboardingIntent = "read-folder" | "extract-text" | "summarize-web"

/**
 * Personalization. Classified `shared`: this is a statement about the person,
 * not the device, so moving to a second device should not re-ask it. Consumed
 * by the welcome-page starter samples and by the character preselect.
 */
export interface OnboardingProfile {
  intent?: OnboardingIntent
  /** Character the user ran their first output with. */
  characterId?: string
}

/** Fresh-install progress: nothing done, entry step is `welcome`. */
export function initialOnboardingProgress(): OnboardingProgress {
  return { version: ONBOARDING_STATE_VERSION, path: "runtime_skipped", lastStep: "welcome" }
}

/**
 * Whether the flow still owes this device a run.
 *
 * `legacy_dismissed` counts as settled — the migration deliberately does not
 * re-prompt users who already dismissed the old dialog, however they meant it.
 */
export function isOnboardingSettled(progress: OnboardingProgress | undefined): boolean {
  if (!progress) return false
  return Boolean(progress.completedAt) || Boolean(progress.skippedAt)
}
