"use client"

import { useMemo } from "react"
import { listCharactersByIds } from "@/lib/db/characters"
import { getTeam } from "@/lib/db/teams"
import { useClientLiveQuery } from "@/hooks/data"
import type { Character, Team } from "@/lib/claude/types"

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
