"use client"

import { useMemo } from "react"
import { listCharactersByIds } from "@/lib/db/characters"
import { getTeam } from "@/lib/db/teams"
import { useClientLiveQuery } from "@/hooks/data"
import type { Character, Team } from "@cognia/agent-config-types"

export function useTeamMembers(teamId: string | null | undefined): readonly Character[] {
  const team = useClientLiveQuery<Team | undefined>(
    () => (teamId ? getTeam(teamId) : Promise.resolve(undefined)),
    [teamId],
    undefined
  )

  const memberIdsKey = team?.members.map((m) => m.characterId).join(",") ?? ""
  const members = useClientLiveQuery<Character[]>(
    () =>
      team ? listCharactersByIds(team.members.map((m) => m.characterId)) : Promise.resolve([]),
    [team?.id, memberIdsKey],
    []
  )

  return useMemo(() => {
    if (!team || !members) return []
    const byId = new Map(members.map((c) => [c.id, c]))
    return team.members
      .map((m) => byId.get(m.characterId))
      .filter((c): c is Character => Boolean(c))
  }, [team, members])
}

/**
 * `characterId` to that member's role in THIS team ("Critic", "Researcher").
 *
 * The role lives on the team's member SLOT, not on the character, because the
 * same character can sit in two teams wearing two hats. Kept separate from
 * `useTeamMembers` so a caller that only renders names does not re-render when
 * a role is edited, and returns an empty map (not undefined) so callers never
 * branch on absence.
 */
export function useTeamMemberRoles(teamId: string | null | undefined): ReadonlyMap<string, string> {
  const team = useClientLiveQuery<Team | undefined>(
    () => (teamId ? getTeam(teamId) : Promise.resolve(undefined)),
    [teamId],
    undefined
  )
  return useMemo(() => {
    const roles = new Map<string, string>()
    for (const member of team?.members ?? []) {
      const role = member.role?.trim()
      if (role) roles.set(member.characterId, role)
    }
    return roles
  }, [team])
}
