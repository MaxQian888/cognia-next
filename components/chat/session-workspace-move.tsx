"use client"

/**
 * Move this conversation to another Workspace.
 *
 * Attribution is correctable: a conversation started in the wrong workspace —
 * or in Default before one existed — would otherwise be stuck there forever,
 * invisible to the workspace it belongs to. The refusals and the rebuilt
 * execution context come from `planSessionMove`; this owns the writes.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { updateSession } from "@/lib/db/sessions"
import { planSessionMove } from "@/lib/chat/move-session-workspace"
import { getExecutionBroker } from "@/lib/execution/broker"
import { useProjectStore } from "@/stores/project/project-store"
import type { ChatSession } from "@cognia/agent-config-types"

export interface SessionWorkspaceMoveProps {
  session: ChatSession
}

export function SessionWorkspaceMove({ session }: SessionWorkspaceMoveProps) {
  const t = useTranslations("chat.header.sheet.workspaceMove")
  const projects = useProjectStore((s) => s.projects)
  const [busy, setBusy] = useState(false)

  async function move(targetId: string) {
    const store = useProjectStore.getState()
    const plan = planSessionMove({
      session,
      target: projects.find((project) => project.id === targetId) ?? null,
      // The broker rather than the store slice: a conversation with no open
      // pane keeps streaming into Dexie, so a store-only check would call a
      // running background turn idle and let the move land underneath it.
      running: getExecutionBroker().hasActiveSession(session.id),
      now: Date.now(),
    })
    if (!plan.ok) {
      toast.error(t(`refused.${plan.reason}`))
      return
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
    } catch (error) {
      toast.error(t("failed", { error: error instanceof Error ? error.message : String(error) }))
    } finally {
      setBusy(false)
    }
  }

  const others = projects.filter((project) => !project.isArchived)
  if (others.length < 2) return null

  return (
    <div className="flex flex-col gap-1" data-testid="session-workspace-move">
      <Select
        value={session.projectId ?? ""}
        disabled={busy}
        onValueChange={(next) => void move(next)}
      >
        <SelectTrigger aria-label={t("label")} size="sm">
          <SelectValue placeholder={t("placeholder")} />
        </SelectTrigger>
        <SelectContent>
          {others.map((project) => (
            <SelectItem key={project.id} value={project.id}>
              {project.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {/* The old managed worktree is left on disk rather than removed: it may
          hold work that was never applied. */}
      <p className="text-xs text-muted-foreground">{t("hint")}</p>
    </div>
  )
}
