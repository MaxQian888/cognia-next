"use client"

/**
 * The verbs a person uses on a run (cancel, resume, approve, reject, roll
 * back), with a busy flag and localized failure toasts. Errors with a code
 * are shown in the person's language; anything else shows its message.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

type Action = "cancel" | "resume" | "approve" | "reject" | "rollback"

const CONTROL_CODES = ["not-found", "not-awaiting", "not-resumable", "not-adopted", "busy"] as const
const ADOPTION_CODES = [
  "no-decision",
  "no-session",
  "no-workspace",
  "agent-changed",
  "agent-not-found",
  "not-adopted",
  "already-rolled-back",
] as const

export function useHarnessRunActions(runId: string | undefined) {
  const t = useTranslations("harnessEvolution.actions")
  const [busy, setBusy] = useState<Action | null>(null)

  const describe = useCallback(
    (error: unknown): string => {
      const code = (error as { code?: unknown })?.code
      const name = (error as { name?: unknown })?.name
      if (name === "HarnessRunControlError" && CONTROL_CODES.includes(code as never)) {
        return t(`errors.control.${code as (typeof CONTROL_CODES)[number]}`)
      }
      if (name === "HarnessAdoptionError" && ADOPTION_CODES.includes(code as never)) {
        return t(`errors.adoption.${code as (typeof ADOPTION_CODES)[number]}`)
      }
      return error instanceof Error ? error.message : String(error)
    },
    [t]
  )

  const perform = useCallback(
    async (
      action: Action,
      work: (control: typeof import("@/lib/harness/runtime/run-control")) => Promise<unknown>
    ) => {
      if (!runId) return
      setBusy(action)
      try {
        const control = await import("@/lib/harness/runtime/run-control")
        await work(control)
        toast.success(t(`done.${action}`))
      } catch (error) {
        toast.error(t(`failed.${action}`), { description: describe(error) })
      } finally {
        setBusy(null)
      }
    },
    [runId, t, describe]
  )

  return {
    busy,
    cancel: () => perform("cancel", (c) => c.cancelHarnessRun(runId as string)),
    // Resume and approve start long work; they return once the run is handed
    // to its driver, not when it finishes.
    resume: () =>
      perform("resume", async (c) => {
        void c
          .resumeHarnessRun(runId as string)
          .catch((error) => toast.error(t("failed.resume"), { description: describe(error) }))
      }),
    approve: (options: { setAsWorkspaceDefault: boolean }) =>
      perform("approve", (c) => c.approveHarnessRun(runId as string, options)),
    reject: () => perform("reject", (c) => c.rejectHarnessRun(runId as string)),
    rollback: () => perform("rollback", (c) => c.rollbackHarnessRun(runId as string)),
    describe,
  }
}
