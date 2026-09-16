/**
 * Acceptance profiles (DESIGN §25.3).
 *
 * A profile names the MINIMUM checks behind a result and the verification
 * level the result may claim. `accepted` means "passed the declared profile",
 * never "every fact is correct". A requested profile can only tighten the
 * server's minimum for the task; asking for `text_basic` on a code task does
 * not make a code change count as verified (PROF-01).
 */

import type { TaskKind, VerificationLevel } from "../contracts/schemas"
import type { VerifierProfile } from "../config/types"

export interface ProfileDefinition {
  id: VerifierProfile
  level: VerificationLevel
  /** Relative strength used to decide whether one profile satisfies another. */
  strength: number
  /** The profile needs a model call (billed as part of the action). */
  needsModelCall: boolean
  /** The profile needs a runtime tool (sandbox, test runner, fixture). */
  needsRuntimeTool: boolean
}

export const PROFILES: Record<VerifierProfile, ProfileDefinition> = {
  text_basic: {
    id: "text_basic",
    level: "schema_only",
    strength: 1,
    needsModelCall: false,
    needsRuntimeTool: false,
  },
  text_review: {
    id: "text_review",
    level: "model_review",
    strength: 2,
    needsModelCall: true,
    needsRuntimeTool: false,
  },
  evidence_review: {
    id: "evidence_review",
    level: "mixed",
    strength: 3,
    needsModelCall: true,
    needsRuntimeTool: false,
  },
  schema_fixture: {
    id: "schema_fixture",
    level: "tool_verified",
    strength: 3,
    needsModelCall: false,
    needsRuntimeTool: true,
  },
  code_fixture: {
    id: "code_fixture",
    level: "tool_verified",
    strength: 4,
    needsModelCall: false,
    needsRuntimeTool: true,
  },
}

export function isVerifierProfile(value: string): value is VerifierProfile {
  return value in PROFILES
}

/**
 * The profile a task must reach before its result may be `accepted`.
 * Everything a code task delivers as a change needs tool verification; a plain
 * chat answer about code is still just an answer (`text_basic`), and is
 * labelled as such by {@link acceptanceClaimFor}.
 */
export function minimumProfileForTask(task: TaskKind, deliversChange: boolean): VerifierProfile {
  if (
    deliversChange &&
    (task === "code.implement" || task === "code.debug" || task === "agent.execute")
  ) {
    return "code_fixture"
  }
  return "text_basic"
}

export interface ProfileResolution {
  profile: VerifierProfile
  /** True when the request asked for something weaker than the server minimum. */
  raisedToMinimum: boolean
}

/** Tighten-only resolution: the stronger of the action, the request and the task minimum wins. */
export function resolveAcceptanceProfile(input: {
  actionProfile: VerifierProfile
  requestedProfile?: string
  task: TaskKind
  deliversChange: boolean
}): ProfileResolution {
  const minimum = minimumProfileForTask(input.task, input.deliversChange)
  const requested =
    input.requestedProfile && isVerifierProfile(input.requestedProfile)
      ? input.requestedProfile
      : undefined
  let profile: VerifierProfile = input.actionProfile
  if (requested && PROFILES[requested].strength > PROFILES[profile].strength) profile = requested
  let raisedToMinimum = false
  if (PROFILES[minimum].strength > PROFILES[profile].strength) {
    profile = minimum
    raisedToMinimum = true
  }
  if (requested && PROFILES[requested].strength < PROFILES[minimum].strength) raisedToMinimum = true
  return { profile, raisedToMinimum }
}

/**
 * Whether an action's own verifier can produce the resolved profile's level.
 * A code task routed to an action that only has `text_basic` cannot be
 * accepted as a change — the router excludes it for change-delivering runs.
 */
export function actionSatisfiesProfile(
  actionProfile: VerifierProfile,
  required: VerifierProfile
): boolean {
  if (actionProfile === required) return true
  const action = PROFILES[actionProfile]
  const need = PROFILES[required]
  if (need.needsRuntimeTool && !action.needsRuntimeTool) return false
  return action.strength >= need.strength
}

export type AcceptanceClaim = "accepted" | "degraded" | "unknown"

/**
 * The quality status a verified result may claim. Only `passed` can be
 * accepted; `inconclusive` is never a pass; a code task answered in plain chat
 * carries `unknown` because no profile verified the code's behaviour.
 */
export function acceptanceClaimFor(input: {
  verificationStatus: "passed" | "failed" | "inconclusive" | "not_applicable"
  profile: VerifierProfile
  task: TaskKind
  deliversChange: boolean
  degraded: boolean
}): AcceptanceClaim {
  if (input.verificationStatus !== "passed") return input.degraded ? "degraded" : "unknown"
  const minimum = minimumProfileForTask(input.task, input.deliversChange)
  if (!actionSatisfiesProfile(input.profile, minimum)) return "unknown"
  if (input.task.startsWith("code.") && !input.deliversChange && input.profile === "text_basic")
    return "unknown"
  return input.degraded ? "degraded" : "accepted"
}
