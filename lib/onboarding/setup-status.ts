import type { OnboardingPath, OnboardingProgress } from "@cognia/agent-config-types"

import { EMPTY_SCAN, hasModelAccess } from "./scan"
import type { OnboardingFocus } from "./route"

/**
 * What is still missing after first-run setup, derived from live state
 * (ADR-0193).
 *
 * ## Why derived, not recorded
 *
 * The finish-setup bar used to print one fixed sentence per exit path. That
 * went stale the moment the user fixed the thing it named somewhere else — a
 * user who skipped sign-in and then added a key in Settings → Providers was
 * still told "Cognia can't reach a model yet" — and it was wrong from the
 * start for exits that had nothing to do with the step they were recorded
 * against: leaving the first-task screen recorded `runtime_skipped`, and the
 * bar blamed a missing runtime on a machine that had one.
 *
 * The recorded path still decides *whether* setup was left unfinished; what
 * is *missing* is re-read from the same live sources the flow itself reads,
 * so every surface that shows it — the bar, the Settings status block, the
 * provider page — agrees, and each gap clears on its own once it is closed.
 */

/** One thing setup still needs, most blocking first. */
export type SetupGap =
  /** No source can reach a model: no credential, provider, key or runtime. */
  | "model"
  /** The first task was picked and its run failed. */
  | "task-failed"
  /** Setup was left before the first task, and nothing has been run since. */
  | "first-task"

/** Exit paths that mean "left before a first real output". */
const UNFINISHED_PATHS: readonly OnboardingPath[] = [
  "provider_skipped",
  "runtime_skipped",
  "task_failed",
]

/**
 * Whether the user deliberately left setup before it produced anything.
 *
 * `skippedAt` is what makes it deliberate: a fresh record carries a
 * placeholder `runtime_skipped` path from the moment the flow starts, and a
 * user still inside the flow has not left anything unfinished. `completedAt`
 * wins over a stale skip, so a later successful run settles it.
 */
export function isSetupUnfinished(progress: OnboardingProgress | undefined): boolean {
  if (!progress?.skippedAt || progress.completedAt) return false
  return UNFINISHED_PATHS.includes(progress.path)
}

export interface LiveModelAccessInput {
  /** `useCredentialStatus().keyOk` — `null` while the probe is in flight. */
  credentialsOk: boolean | null
  /** A settings-resolved provider + credential (`resolveStandaloneProvider`). */
  providerConfigured: boolean
  /** `settings.apiKey`, the legacy Anthropic-only slot. */
  legacyApiKey?: string
  /** An external agent that brings its own credentials is connected. */
  externalRuntimeReady: boolean
}

/**
 * Whether this device can reach a model right now — without the machine scan.
 *
 * The flow folds an authenticated CLI from its scan into `hasModelAccess`; the
 * app outside the flow does not run that scan (it spawns processes), and
 * instead sees the same fact from the other side, as a connected external
 * runtime. Everything else is the same rule, which is why this delegates.
 *
 * `null` means "cannot say yet": the credential probe is still in flight, or
 * this is a paired phone that borrows the desktop's credentials and has
 * nothing local to answer with. Callers must not treat it as "missing".
 */
export function resolveLiveModelAccess(input: LiveModelAccessInput): boolean | null {
  const found = hasModelAccess({
    scan: EMPTY_SCAN,
    credentialsOk: input.credentialsOk,
    providerConfigured: input.providerConfigured,
    legacyApiKey: input.legacyApiKey,
    externalRuntimeReady: input.externalRuntimeReady,
  })
  if (found) return true
  return input.credentialsOk === null ? null : false
}

export interface SetupGapInput {
  progress: OnboardingProgress | undefined
  /** {@link resolveLiveModelAccess}; `null` never raises a gap. */
  modelAccess: boolean | null
  /** Chat sessions on this device; `null` while the count loads. */
  sessionCount: number | null
}

/**
 * Every gap, most blocking first.
 *
 * Deliberately blind to `finishBarDismissed`: dismissing the bar is "stop
 * reminding me", not "this is done", so Settings still reports the truth.
 * The bar applies its own dismissal on top.
 */
export function deriveSetupGaps({
  progress,
  modelAccess,
  sessionCount,
}: SetupGapInput): SetupGap[] {
  const gaps: SetupGap[] = []
  if (modelAccess === false) gaps.push("model")
  if (!isSetupUnfinished(progress)) return gaps
  if (progress?.path === "task_failed") gaps.push("task-failed")
  // Any conversation since means the product has been put to work; asking
  // for a "first" task after that would be a nag, not a guide.
  else if (sessionCount === 0) gaps.push("first-task")
  return gaps
}

/** Where in the flow a gap is closed. */
export function focusForGap(gap: SetupGap): OnboardingFocus {
  return gap === "model" ? "model" : "task"
}
