import type { OnboardingMode, OnboardingShell, OnboardingStepId } from "@cognia/agent-config-types"

/**
 * The canonical onboarding step order, plus which shells each step applies to.
 *
 * **This array is the single source of truth for "what step appears where".**
 * Adding, reordering, or retargeting a step is a one-line change here; the
 * rail, the back/next routing, and the resume logic all derive from it. The
 * predecessor spread the same knowledge across two `useEffect` copies in
 * `desktop-chat-workspace.tsx` and `app-shell-mobile.tsx`, which had already
 * drifted.
 *
 * Modelled on Multica's `ONBOARDING_STEP_ORDER` but with a shell dimension it
 * does not need: Multica forks its whole runtime step into a separate
 * component for web, whereas Cognia has four contexts and would need four.
 *
 * Since the welcome screen forks, each step also declares the **paths** it
 * belongs to. The two paths are not two orderings of the same screens: the
 * recommended path's `express` screen *is* the scan, sign-in and first-run
 * steps folded into one surface, so it replaces them rather than preceding
 * them. That is why `mode` filters here rather than being a flag a step reads.
 *
 * Two steps are conditional beyond `availableIn` and are filtered at runtime by
 * {@link resolveStepSequence}:
 *
 *  - `scan` is skipped where there is no local runtime to find.
 *  - `provider` is skipped once the scan turned up usable model access — an
 *    already-authenticated `claude-code` on the machine means the user needs
 *    no Cognia-side credentials to reach a first output.
 */
export interface OnboardingStepDef {
  id: OnboardingStepId
  availableIn: readonly OnboardingShell[]
  /**
   * Which paths through setup include this step. `welcome` is in both — it is
   * where the fork is asked.
   */
  modes: readonly OnboardingMode[]
  /**
   * Steps the rail renders as progress. `welcome` is excluded: reading a
   * product intro is not progress toward being set up, and showing "step 1 of
   * 4" on it makes the flow feel longer than it is.
   */
  countsAsProgress: boolean
}

export const ONBOARDING_STEPS: readonly OnboardingStepDef[] = [
  {
    id: "welcome",
    // Every shell shows it. On mobile it additionally carries the
    // standalone/paired mode fork absorbed from the old `/welcome` route.
    availableIn: ["tauri", "web", "mobile-standalone", "mobile-paired"],
    modes: ["express", "custom"],
    countsAsProgress: false,
  },
  {
    id: "express",
    // Every shell, including the two with nothing local to scan: a browser's
    // recommended path is the sign-in line plus the capability line plus the
    // starter cards, which still folds two screens into one. A paired phone's
    // is the pairing line plus the cards.
    availableIn: ["tauri", "web", "mobile-standalone", "mobile-paired"],
    modes: ["express"],
    // In the sequence for resume and back/next, but the panel hides the
    // stepper in this mode: "1 of 1" is not progress information.
    countsAsProgress: true,
  },
  {
    id: "scan",
    // Desktop scans for agent CLIs and offers migration. A paired phone
    // reaches this step too, but its body is the pairing flow — the compute it
    // is "scanning for" lives on the desktop it is about to pair with.
    availableIn: ["tauri", "mobile-paired"],
    modes: ["custom"],
    countsAsProgress: true,
  },
  {
    id: "provider",
    // Not offered to a paired phone: it borrows the desktop's credentials, so
    // asking it to authenticate separately would configure the wrong machine.
    availableIn: ["tauri", "web", "mobile-standalone"],
    modes: ["custom"],
    countsAsProgress: true,
  },
  {
    id: "first-run",
    availableIn: ["tauri", "web", "mobile-standalone", "mobile-paired"],
    modes: ["custom"],
    countsAsProgress: true,
  },
] as const

/** Runtime facts that decide the two conditional steps. */
export interface StepSequenceInput {
  shell: OnboardingShell
  /**
   * Which path the user picked on the welcome screen. `undefined` before they
   * have — which yields the intro alone, because every step after it belongs
   * to one path or the other and picking for them would take the fork away.
   */
  mode: OnboardingMode | undefined
  /**
   * True once the user has model access from *any* source — a Cognia
   * subscription/API key, or a usable runtime the scan found. Suppresses the
   * provider step.
   */
  hasModelAccess: boolean
}

/**
 * The ordered steps this device should actually walk.
 *
 * Filtering happens in one pass so the rail, the "next step" arrow and the
 * resume logic can never disagree about the sequence.
 */
export function resolveStepSequence({
  shell,
  hasModelAccess,
  mode,
}: StepSequenceInput): OnboardingStepDef[] {
  return ONBOARDING_STEPS.filter((step) => {
    if (!step.availableIn.includes(shell)) return false
    // No fork answer yet: only the screen that asks it.
    if (!mode) return step.id === "welcome"
    if (!step.modes.includes(mode)) return false
    if (step.id === "provider" && hasModelAccess) return false
    return true
  })
}

/**
 * The step after `from`, or `null` when `from` is the last one.
 *
 * Returns the *first* step when `from` is not in the sequence — that happens
 * when a resumed `lastStep` names a step this device no longer shows (the user
 * switched a phone from paired to standalone, say), and restarting beats
 * stranding them on a step that is not in their sequence.
 */
export function nextStep(
  sequence: readonly OnboardingStepDef[],
  from: OnboardingStepId
): OnboardingStepId | null {
  const idx = sequence.findIndex((s) => s.id === from)
  if (idx < 0) return sequence[0]?.id ?? null
  return sequence[idx + 1]?.id ?? null
}

/** The step before `from`, or `null` when `from` is the entry step. */
export function previousStep(
  sequence: readonly OnboardingStepDef[],
  from: OnboardingStepId
): OnboardingStepId | null {
  const idx = sequence.findIndex((s) => s.id === from)
  if (idx <= 0) return null
  return sequence[idx - 1]?.id ?? null
}

/**
 * Where to resume. A persisted `lastStep` wins only if it is still in this
 * device's sequence; otherwise we start over rather than land on a step that
 * was filtered out.
 */
export function resumeStep(
  sequence: readonly OnboardingStepDef[],
  lastStep: OnboardingStepId | undefined
): OnboardingStepId | null {
  if (lastStep && sequence.some((s) => s.id === lastStep)) return lastStep
  return sequence[0]?.id ?? null
}

/**
 * Position within the progress-bearing steps, for the rail. `welcome` reports
 * `index: -1` so callers can render it without a counter.
 */
export function progressPosition(
  sequence: readonly OnboardingStepDef[],
  current: OnboardingStepId
): { index: number; total: number } {
  const counted = sequence.filter((s) => s.countsAsProgress)
  return { index: counted.findIndex((s) => s.id === current), total: counted.length }
}
