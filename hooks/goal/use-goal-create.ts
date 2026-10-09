"use client"

/**
 * Start a goal on a conversation, over the right transport.
 *
 * The goal's loop runs where the conversation's host is. On the desktop (and
 * in a browser profile, its own host) that is this process: the goal is
 * created through `GoalRuntime.createGoal` / `createGoalFromTemplate`, which
 * redact the objective and hold the one-open-goal-per-session invariant. On
 * the mobile companion the loop runs on the paired desktop, so the goal is
 * created there over `goal_create` (the same runtime call, run on the
 * desktop), and only by a device holding the remote-control grant. A template
 * is read on this device, where the user picked it, and its objective and
 * config overrides travel with the call.
 *
 * The per-goal verbs live in `useGoalControls`; creating one is not bound to a
 * goal, so it is its own hook. `create` throws, so the form that called it can
 * keep its input and say what went wrong.
 */

import { useCallback } from "react"
import type { AppSettings } from "@cognia/agent-config-types"

import { useCanControl } from "@/hooks/data/use-can-control"
import { usePlatform } from "@/hooks/use-platform"
import { getGoalRuntime } from "@/lib/goal/runtime"
import { createGoalFromTemplate, resolveGoalTemplate } from "@/lib/goal/templates"
import { transport } from "@/lib/tauri/transport-instance"

/** An objective typed by the user, or a saved template's. */
export type GoalCreateInput = {
  sessionId: string
  /** Feeds the local runtime's config defaults and redaction allowlist. */
  appSettings: AppSettings | null
} & (
  | { rawObjective: string; templateId?: undefined }
  | { templateId: string; rawObjective?: undefined }
)

export interface GoalCreate {
  /** The goal is created on the paired desktop, over `goal_create`. */
  remote: boolean
  /** Always `true` locally; on the mobile companion, the remote-control grant. */
  allowed: boolean
  /** Create the goal. Throws on failure, including a phone without the grant. */
  create: (input: GoalCreateInput) => Promise<void>
}

export function useGoalCreate(): GoalCreate {
  const remote = usePlatform() === "mobile"
  const canControl = useCanControl()
  const allowed = remote ? canControl === true : true

  const create = useCallback(
    async (input: GoalCreateInput) => {
      if (!remote) {
        if (input.templateId !== undefined) {
          await createGoalFromTemplate({
            templateId: input.templateId,
            sessionId: input.sessionId,
            appSettings: input.appSettings,
          })
        } else {
          await getGoalRuntime().createGoal({
            sessionId: input.sessionId,
            rawObjective: input.rawObjective,
            appSettings: input.appSettings,
          })
        }
        return
      }
      if (!allowed) {
        // The desktop would refuse it anyway (`goal_create` is control-gated);
        // saying so here keeps the refusal from looking like a network error.
        throw new Error("goal_create needs the remote-control grant on this device")
      }
      const { rawObjective, config } =
        input.templateId !== undefined
          ? await resolveGoalTemplate(input.templateId)
          : { rawObjective: input.rawObjective, config: undefined }
      // The desktop loads its own settings for the defaults and the redaction
      // allowlist; this device's settings do not travel.
      await transport.call("goal_create", {
        sessionId: input.sessionId,
        rawObjective,
        ...(config ? { config } : {}),
      })
    },
    [remote, allowed]
  )

  return { remote, allowed, create }
}
