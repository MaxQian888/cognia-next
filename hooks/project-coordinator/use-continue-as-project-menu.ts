"use client"

import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import type { ChatSession } from "@cognia/agent-config-types"
import { sessionHref } from "@/lib/issues/run/agent-task-adapter"
import { continueAsProjectRefusal } from "@/lib/project-coordinator/continue-eligibility"

/**
 * The conversation row's "Continue as project" action (ADR-0204), shared by
 * the desktop row menu and the phone's action sheet the way the workspace
 * move is. Offered only for a conversation that can become a project thread;
 * whether it is busy is checked when the action runs.
 */
export function useContinueAsProjectMenu(session: ChatSession): {
  onContinueAsProject?: () => void
} {
  const t = useTranslations("projectCoordinator.continue")
  const router = useRouter()
  if (continueAsProjectRefusal(session) !== null) return {}

  const run = async () => {
    try {
      // Loaded on pick: every conversation row mounts this hook, and the action
      // reaches the chat runtime and the message store.
      const { continueAsProject } = await import("@/lib/project-coordinator/continue-as-project")
      const result = await continueAsProject({
        sessionId: session.id,
        coordinatorTitle: t("coordinatorTitle"),
      })
      if (result.kind === "refused") {
        toast.error(t(`refused.${result.reason}`))
        return
      }
      toast.success(result.seeded ? t("done") : t("doneNotSeeded"))
      router.push(sessionHref(result.coordinator.id))
    } catch (error) {
      toast.error(t("failed", { error: error instanceof Error ? error.message : String(error) }))
    }
  }
  return { onContinueAsProject: () => void run() }
}
