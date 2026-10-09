"use client"

/**
 * Every verb that drives one goal, over the right transport.
 *
 * The goal loop runs where the conversation's host is. On the desktop (and in
 * a browser profile, which is its own host) that is this process, so the
 * controls drive `getGoalRuntime()` and the goal modules directly. On the
 * mobile companion the loop runs on the paired desktop, so the same verbs
 * round-trip through the Companion goal RPCs and only show for a device
 * holding the remote-control grant (`useCanControl`):
 *
 * | Verb | Local | Companion RPC |
 * | --- | --- | --- |
 * | pause / resume / stop | `GoalRuntime` transitions | `goal_pause` / `goal_resume` / `goal_stop` |
 * | continueTurn | `requestManualContinue` | `goal_continue` |
 * | accept | `resolveGoalAcceptance` | `goal_accept` |
 * | deleteGoal | `GoalRuntime.deleteGoal` | `goal_delete` |
 * | updateObjective / updateConfig | `GoalRuntime` | `goal_update` |
 * | disableVerification | `disableGoalVerification` | `goal_update` with `verificationWorkflow: null` |
 * | retryVerification | `retryPausedGoalVerification` | `goal_verify_retry` |
 * | generateSubgoals | `generateGoalSubgoals` | `goal_subgoals_generate` |
 * | setSubgoalDone | `GoalRuntime.setSubgoalDone` | `goal_subgoal_mark` |
 * | clearSubgoals | `GoalRuntime.clearSubgoals` | `goal_subgoals_clear` |
 *
 * Creating a goal is not bound to one, so it lives in `useGoalCreate`.
 *
 * Keyed on the platform, not on the viewport: a desktop window narrowed below
 * 768px renders the phone-shaped Goals body, and it used to send those RPCs to
 * a host that does not serve them, so every button there failed.
 *
 * Every verb reports failure with a toast and resolves `false` (or `null`), so
 * callers never need their own try/catch to stay honest.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { useCanControl } from "@/hooks/data/use-can-control"
import { usePlatform } from "@/hooks/use-platform"
import { getGoalRuntime } from "@/lib/goal/runtime"
import type { GoalSubgoalsGenerateWireResult } from "@/lib/goal/subgoal-generation"
import type { GoalVerificationOutcome } from "@/lib/goal/verification"
import { transport } from "@/lib/tauri/transport-instance"
import { useSettingsStore } from "@/stores/settings"
import type { Goal, GoalConfig } from "@/types/goal"

type RemoteGoalCommand = "goal_pause" | "goal_resume" | "goal_stop"

/**
 * What a verifier retry came to. `running` only happens over the companion:
 * the desktop answers inside its bridge deadline and the verifier keeps going,
 * its result landing on the goal's `verification` state.
 */
export type GoalVerifyRetryResult =
  { state: "settled"; outcome: GoalVerificationOutcome } | { state: "running" }

/**
 * What generating the subgoal checklist came to, for the Subgoals tab:
 * `generated`, `empty` (retryable; any prior checklist kept), `unavailable`
 * (no model with a key on the host that runs the loop), `missing` (the goal is
 * gone), `running` (companion only: the desktop is still generating, and the
 * checklist arrives on the goal row's sync), or `failed` (already reported).
 */
export type GoalSubgoalsGenerateOutcome = GoalSubgoalsGenerateWireResult["outcome"] | "failed"

export interface GoalControls {
  /** The loop runs on another device; verbs go over the Companion RPCs. */
  remote: boolean
  /**
   * Whether this surface may drive the goal at all. Always `true` locally; on
   * the mobile companion it is the remote-control probe's answer.
   */
  allowed: boolean
  /** A verb is in flight. */
  busy: boolean
  /** One manual turn is offered: an active `manualContinue` goal this surface may drive. */
  canContinue: boolean
  pause: () => Promise<boolean>
  resume: () => Promise<boolean>
  stop: () => Promise<boolean>
  /**
   * Release the turn a `manualContinue` goal is holding. Resolves whether one
   * was held; over the companion, "nothing was waiting" is said with a toast.
   */
  continueTurn: () => Promise<boolean>
  /**
   * The acceptance verdict on a goal the gate parked: `true` completes it,
   * `false` requests changes and resumes it. Confirms with a toast.
   */
  accept: (accepted: boolean) => Promise<boolean>
  /** Delete the goal and its activity log. Confirms with a toast. */
  deleteGoal: () => Promise<boolean>
  /**
   * Replace the objective (redacted, in-flight turn aborted). `"updated"`,
   * `"unchanged"` when the runtime refused (goal ended, or the redacted text
   * is what the model already has), or `"failed"` (already reported).
   */
  updateObjective: (rawObjective: string) => Promise<"updated" | "unchanged" | "failed">
  /** Patch the goal's config. Resolves `false` on failure (already reported). */
  updateConfig: (patch: Partial<GoalConfig>) => Promise<boolean>
  /**
   * Remove the completion verifier: the goal resumes and its pending
   * completion candidate is dropped. Resolves `false` on failure (reported).
   */
  disableVerification: () => Promise<boolean>
  /**
   * Re-run a failed or errored completion verifier. `null` on failure
   * (already reported); the caller words the outcome.
   */
  retryVerification: () => Promise<GoalVerifyRetryResult | null>
  /**
   * Generate (or regenerate) the subgoal checklist with the model of the host
   * that runs the loop. The caller words the outcome.
   */
  generateSubgoals: () => Promise<GoalSubgoalsGenerateOutcome>
  /**
   * Check or uncheck one checklist step. Sends the wanted state, so a retried
   * call cannot undo itself. Resolves `false` on failure (reported under the
   * step title).
   */
  setSubgoalDone: (subgoalId: string, done: boolean) => Promise<boolean>
  /** Remove the checklist. Resolves `false` on failure (reported under the clear title). */
  clearSubgoals: () => Promise<boolean>
}

export function useGoalControls(
  goal: Pick<Goal, "id" | "status" | "config"> | null | undefined
): GoalControls {
  const t = useTranslations("goal")
  const remote = usePlatform() === "mobile"
  const canControl = useCanControl()
  const allowed = remote ? canControl === true : true
  const [busy, setBusy] = useState(false)
  const goalId = goal?.id

  const reportFailure = useCallback(
    (error: unknown, localTitle?: string) => {
      if (remote) toast.error(t("remote.failed"))
      else
        toast.error(localTitle ?? t("controls.failed"), {
          description: error instanceof Error ? error.message : String(error),
        })
    },
    [remote, t]
  )

  /**
   * One verb: the busy flag, the transport choice and the failure report.
   * `local` runs on this host, `viaCompanion` on the paired desktop; either
   * answers what the caller resolves with. `fallback` is what a missing goal or
   * a failure resolves with.
   */
  const perform = useCallback(
    async <T>(
      local: (id: string) => Promise<T>,
      viaCompanion: (id: string) => Promise<T>,
      fallback: T,
      localFailureTitle?: string
    ): Promise<T> => {
      if (!goalId) return fallback
      setBusy(true)
      try {
        return remote ? await viaCompanion(goalId) : await local(goalId)
      } catch (error) {
        reportFailure(error, localFailureTitle)
        return fallback
      } finally {
        setBusy(false)
      }
    },
    [goalId, remote, reportFailure]
  )

  const transition = useCallback(
    (local: (id: string) => Promise<unknown>, command: RemoteGoalCommand) =>
      perform(
        async (id) => {
          await local(id)
          return true
        },
        async (id) => {
          await transport.call(command, { goalId: id })
          // The status flip lands through the normal `goals` sync-down; the
          // toast only confirms the desktop accepted the transition.
          toast.success(t("remote.applied"))
          return true
        },
        false
      ),
    [perform, t]
  )

  const pause = useCallback(
    () => transition((id) => getGoalRuntime().pauseGoal(id), "goal_pause"),
    [transition]
  )
  const resume = useCallback(
    () => transition((id) => getGoalRuntime().resumeGoal(id), "goal_resume"),
    [transition]
  )
  const stop = useCallback(
    () => transition((id) => getGoalRuntime().stopGoal(id), "goal_stop"),
    [transition]
  )

  const continueTurn = useCallback(
    () =>
      perform(
        async (id) => getGoalRuntime().requestManualContinue(id),
        async (id) => {
          const result = await transport.call<{ continued?: boolean }>("goal_continue", {
            goalId: id,
          })
          const continued = result?.continued === true
          if (continued) toast.success(t("remote.applied"))
          // The desktop holds no turn for this goal: it was already released,
          // or the turn has not finished yet.
          else toast.info(t("remote.nothingToContinue"))
          return continued
        },
        false
      ),
    [perform, t]
  )

  const accept = useCallback(
    (accepted: boolean) =>
      perform(
        async (id) => {
          const { resolveGoalAcceptance } = await import("@/lib/goal/acceptance")
          await resolveGoalAcceptance(id, accepted)
          toast.success(accepted ? t("acceptance.accepted") : t("acceptance.changesRequested"))
          return true
        },
        async (id) => {
          await transport.call("goal_accept", { goalId: id, accepted })
          toast.success(t("remote.applied"))
          return true
        },
        false,
        t("acceptance.failed")
      ),
    [perform, t]
  )

  const deleteGoal = useCallback(
    () =>
      perform(
        async (id) => {
          await getGoalRuntime().deleteGoal(id)
          toast.success(t("actions.deleted"))
          return true
        },
        async (id) => {
          // The row leaves this device through the `goals` tombstone on the
          // next sync-down.
          await transport.call("goal_delete", { goalId: id })
          toast.success(t("actions.deleted"))
          return true
        },
        false,
        t("actions.deleteFailed")
      ),
    [perform, t]
  )

  const updateObjective = useCallback(
    (rawObjective: string) =>
      perform<"updated" | "unchanged" | "failed">(
        async (id) =>
          (await getGoalRuntime().updateObjective(id, rawObjective)) ? "updated" : "unchanged",
        async (id) => {
          // `goal_update` runs the same `updateObjective` on the desktop.
          const result = await transport.call<{ goal: unknown; updatePrompt?: string }>(
            "goal_update",
            { goalId: id, rawObjective }
          )
          // The desktop answers the goal row either way (it falls back to the
          // stored row when nothing changed); only an applied update carries
          // the model-facing update prompt.
          return typeof result?.updatePrompt === "string" ? "updated" : "unchanged"
        },
        "failed"
      ),
    [perform]
  )

  const updateConfig = useCallback(
    (patch: Partial<GoalConfig>) =>
      perform(
        async (id) => {
          await getGoalRuntime().updateConfig(id, patch)
          return true
        },
        async (id) => {
          await transport.call("goal_update", { goalId: id, config: patch })
          return true
        },
        false
      ),
    [perform]
  )

  const disableVerification = useCallback(
    () =>
      perform(
        async (id) => {
          const { disableGoalVerification } = await import("@/lib/goal/verification")
          await disableGoalVerification(id)
          return true
        },
        async (id) => {
          // An explicit null is `goal_update`'s "remove the verifier", which
          // runs `disableGoalVerification` on the desktop.
          await transport.call("goal_update", {
            goalId: id,
            config: { verificationWorkflow: null },
          })
          return true
        },
        false
      ),
    [perform]
  )

  const retryVerification = useCallback(
    () =>
      perform<GoalVerifyRetryResult | null>(
        async (id) => {
          const { retryPausedGoalVerification } = await import("@/lib/goal/verification")
          return { state: "settled", outcome: await retryPausedGoalVerification(id) }
        },
        async (id) => transport.call<GoalVerifyRetryResult>("goal_verify_retry", { goalId: id }),
        null
      ),
    [perform]
  )

  const generateSubgoals = useCallback(
    () =>
      perform<GoalSubgoalsGenerateOutcome>(
        async (id) => {
          const { generateGoalSubgoals } = await import("@/lib/goal/subgoal-generation")
          // Read at call time: the verb needs the settings once, not a
          // subscription that re-renders every goal surface on a settings write.
          const result = await generateGoalSubgoals(id, useSettingsStore.getState().settings)
          return result.outcome
        },
        async (id) => {
          // Generated on the desktop with ITS model and key; the checklist
          // reaches this device on the `goals` sync-down.
          const result = await transport.call<GoalSubgoalsGenerateWireResult>(
            "goal_subgoals_generate",
            { goalId: id }
          )
          return result?.outcome ?? "failed"
        },
        "failed"
      ),
    [perform]
  )

  const setSubgoalDone = useCallback(
    (subgoalId: string, done: boolean) =>
      perform(
        async (id) => {
          await getGoalRuntime().setSubgoalDone(id, subgoalId, done)
          return true
        },
        async (id) => {
          await transport.call("goal_subgoal_mark", { goalId: id, subgoalId, done })
          return true
        },
        false,
        t("subgoals.toggleFailed")
      ),
    [perform, t]
  )

  const clearSubgoals = useCallback(
    () =>
      perform(
        async (id) => {
          await getGoalRuntime().clearSubgoals(id)
          return true
        },
        async (id) => {
          await transport.call("goal_subgoals_clear", { goalId: id })
          return true
        },
        false,
        t("subgoals.clearFailed")
      ),
    [perform, t]
  )

  return {
    remote,
    allowed,
    busy,
    canContinue: allowed && goal?.status === "active" && goal.config.manualContinue === true,
    pause,
    resume,
    stop,
    continueTurn,
    accept,
    deleteGoal,
    updateObjective,
    updateConfig,
    disableVerification,
    retryVerification,
    generateSubgoals,
    setSubgoalDone,
    clearSubgoals,
  }
}
