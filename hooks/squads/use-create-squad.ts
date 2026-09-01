"use client"

/**
 * Creating a Squad from a surface, with the durable default resolved.
 *
 * `createSquad` cannot be called from the store's synchronous `createTeam`,
 * because resolving the durable-v2 default needs two Dexie reads and a host
 * preflight. So every surface that creates one has to assemble the same three
 * pieces: the store action, the active `Project` row, and the naming. The
 * Settings library was the only surface that did, which is a large part of why
 * creating a Squad meant navigating there.
 *
 * The names come from the caller's own namespace rather than from here, so the
 * fleet console and the Settings library can each say what fits their surface
 * without this hook growing an opinion about i18n.
 */

import { useCallback } from "react"

import { createSquad } from "@/lib/agent-team/create-squad"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { useProjectStore } from "@/stores/project/project-store"
import type { AgentTeam } from "@/types/agent/agent-team"

export interface CreateSquadNames {
  /** Display name for the new Squad. */
  name: string
  /** Display name for its auto-created lead. */
  leadName: string
}

export function useCreateSquad(): (names: CreateSquadNames) => Promise<AgentTeam> {
  const createTeam = useAgentTeamStore((s) => s.createTeam)
  const project = useProjectStore((state) =>
    state.projects.find((candidate) => candidate.id === state.activeProjectId)
  )
  return useCallback(
    (names) =>
      createSquad(
        { name: names.name, task: "", leadName: names.leadName },
        { createTeam, project }
      ),
    [createTeam, project]
  )
}
