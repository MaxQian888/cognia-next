"use client"

/**
 * The assignable actors: the local human, every Character, every AgentTeam in
 * this workspace.
 *
 * Extracted from `components/issues/assignee-picker.tsx` so the context menu
 * and the bulk toolbar offer exactly the same set. Three components each
 * assembling their own list is how one of them ends up still offering a team
 * from another workspace.
 *
 * External agents stay out, for the reason `IssueActor` documents: the run
 * adapters cannot dispatch to them, so an external assignee is an issue that
 * can never be run.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"

import { buildAssigneeOptions, type AssigneeOption } from "@/components/issues/assignee-picker"
import { useClientLiveQuery } from "@/hooks/data"
import { listCharacters } from "@/lib/db/characters"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { useProjectStore } from "@/stores/project/project-store"

export function useAssigneeOptions(): AssigneeOption[] {
  const t = useTranslations("issues")
  const characters = useClientLiveQuery(() => listCharacters(), [], [])
  const teamsById = useAgentTeamStore((state) => state.teams)
  const workspaceId = useProjectStore((state) => state.activeProjectId)

  return useMemo(() => {
    const teams = Object.values(teamsById)
      // Teams are workspace-scoped; a team from another workspace cannot be
      // dispatched from this board.
      .filter((team) => !workspaceId || !team.projectId || team.projectId === workspaceId)
      .map((team) => ({ id: team.id, name: team.name }))
    return buildAssigneeOptions(
      (characters ?? []).map((character) => ({ id: character.id, name: character.name })),
      teams,
      t("actor.human")
    )
  }, [characters, teamsById, workspaceId, t])
}
