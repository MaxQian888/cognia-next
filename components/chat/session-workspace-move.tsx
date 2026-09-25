"use client"

/**
 * Move this conversation to another Workspace.
 *
 * Attribution is correctable: a conversation started in the wrong workspace —
 * or in Default before one existed — would otherwise be stuck there forever,
 * invisible to the workspace it belongs to. The move itself, refusals and
 * writes, is `useMoveSessionWorkspace`.
 */

import { useTranslations } from "next-intl"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useMoveSessionWorkspace } from "@/hooks/workspace/use-move-session-workspace"
import { useProjectStore } from "@/stores/project/project-store"
import type { ChatSession } from "@cognia/agent-config-types"

export interface SessionWorkspaceMoveProps {
  session: ChatSession
}

export function SessionWorkspaceMove({ session }: SessionWorkspaceMoveProps) {
  const t = useTranslations("chat.header.sheet.workspaceMove")
  const projects = useProjectStore((s) => s.projects)
  // The same move the conversation list's row menu makes.
  const { move, busy } = useMoveSessionWorkspace()

  // Archived workspaces are not destinations, but the one this conversation is
  // in still has to name itself: Radix renders an EMPTY trigger for a value
  // with no matching item, which read as "in no workspace at all".
  const options = projects.filter(
    (project) => !project.isArchived || project.id === session.projectId
  )
  const destinations = options.filter(
    (project) => !project.isArchived && project.id !== session.projectId
  )
  if (destinations.length === 0) return null

  return (
    <div className="flex flex-col gap-1" data-testid="session-workspace-move">
      <Select
        value={session.projectId ?? ""}
        disabled={busy}
        onValueChange={(next) => void move(session, next)}
      >
        <SelectTrigger aria-label={t("label")} size="sm">
          <SelectValue placeholder={t("placeholder")} />
        </SelectTrigger>
        <SelectContent>
          {options.map((project) => (
            <SelectItem key={project.id} value={project.id} disabled={project.isArchived}>
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
