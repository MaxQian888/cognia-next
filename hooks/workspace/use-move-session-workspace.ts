"use client"

/**
 * Move a conversation to another Workspace, from any control that offers it.
 *
 * Attribution is correctable (ADR-0144): a conversation started in the wrong
 * workspace, or in Default before one existed, would otherwise be stuck there,
 * invisible to the workspace it belongs to. The session settings sheet offered
 * the move and the conversation list did not, and the list is where a reader
 * notices a conversation in the wrong place. Both call this, so there is one
 * copy of the three writes a move is: the `projectId` column, an execution
 * context rebuilt against the destination's root, and the roster on both sides.
 *
 * The refusals and the rebuilt context come from `planSessionMove`; this owns
 * the writes and says what happened. The planner, the broker and the session
 * table are loaded on the first move rather than with the hook: every row of
 * the conversation list mounts it, and almost none of them ever moves.
 */

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { useProjectStore } from "@/stores/project/project-store"
import type { ChatSession } from "@cognia/agent-config-types"

export type MovableSession = Pick<
  ChatSession,
  "id" | "projectId" | "executionContext" | "handoffLock"
>

export interface MoveSessionWorkspace {
  /** Resolves true when the conversation moved, false when it was refused or failed. */
  move: (session: MovableSession, targetId: string) => Promise<boolean>
  busy: boolean
}

export function useMoveSessionWorkspace(): MoveSessionWorkspace {
  const t = useTranslations("chat.header.sheet.workspaceMove")
  const [busy, setBusy] = useState(false)

  const move = useCallback(
    async (session: MovableSession, targetId: string) => {
      // The roster writes below persist through the project store, whose own
      // `persist()` is gated on `loaded`. A move issued before the boot
      // initializer hydrated it would write the column and reach no roster.
      await useProjectStore.getState().load()
      const store = useProjectStore.getState()
      const [{ planSessionMove }, { getExecutionBroker }, { updateSession }] = await Promise.all([
        import("@/lib/chat/move-session-workspace"),
        import("@/lib/execution/broker"),
        import("@/lib/db/sessions"),
      ])
      const plan = planSessionMove({
        session,
        target: store.projects.find((project) => project.id === targetId) ?? null,
        // The broker rather than the store slice: a conversation with no open
        // pane keeps streaming into Dexie, so a store-only check would call a
        // running background turn idle and let the move land underneath it.
        running: getExecutionBroker().hasActiveSession(session.id),
        now: Date.now(),
      })
      if (!plan.ok) {
        toast.error(t(`refused.${plan.reason}`))
        return false
      }
      setBusy(true)
      try {
        await updateSession(session.id, {
          projectId: plan.projectId,
          executionContext: plan.executionContext,
        })
        if (plan.previousProjectId) {
          store.removeSessionFromProject(plan.previousProjectId, session.id)
        }
        store.addSessionToProject(plan.projectId, session.id)
        toast.success(t("moved"))
        return true
      } catch (error) {
        toast.error(t("failed", { error: error instanceof Error ? error.message : String(error) }))
        return false
      } finally {
        setBusy(false)
      }
    },
    [t]
  )

  return { move, busy }
}

export interface SessionWorkspaceMoveMenu {
  /** Non-archived workspaces; the conversation's own is listed checked and inert. */
  workspaceTargets: readonly { id: string; name: string }[]
  /** There is somewhere else to move it. */
  canMoveWorkspace: boolean
  movingWorkspace: boolean
  onMoveWorkspace: (workspaceId: string) => void
}

/**
 * The "Move to workspace" submenu for one conversation row — what the desktop
 * row menu and the mobile action sheet both offer. Archived workspaces are not
 * destinations. Reads the stable store array and filters it here, so a row
 * does not re-render for unrelated project-store writes.
 */
export function useSessionWorkspaceMoveMenu(session: MovableSession): SessionWorkspaceMoveMenu {
  const projects = useProjectStore((s) => s.projects)
  const workspaceTargets = useMemo(
    () => projects.filter((workspace) => !workspace.isArchived),
    [projects]
  )
  const { move, busy } = useMoveSessionWorkspace()
  return {
    workspaceTargets,
    canMoveWorkspace: workspaceTargets.some((workspace) => workspace.id !== session.projectId),
    movingWorkspace: busy,
    onMoveWorkspace: (workspaceId) => void move(session, workspaceId),
  }
}
