/**
 * People (ADR-0129): characters (→ start a chat with them) and teams (→ switch
 * the guild rail to the team). Both come from Dexie through the list-provider
 * cache and render with the shared avatar badge.
 */

import type { Character, Team } from "@cognia/agent-config-types"

import { listCharacters } from "@/lib/db/characters"
import { listTeams } from "@/lib/db/teams"
import { createListProvider } from "./list-provider"

export const CHARACTERS_PROVIDER_ID = "builtin.characters"
export const TEAMS_PROVIDER_ID = "builtin.teams"

export interface PeopleProviderDeps {
  listCharacters: () => Promise<Character[]>
  listTeams: () => Promise<Team[]>
}

export function createCharactersProvider(deps: Pick<PeopleProviderDeps, "listCharacters">) {
  return createListProvider<Character>({
    id: CHARACTERS_PROVIDER_ID,
    kind: "character",
    load: () => deps.listCharacters(),
    getTitle: (c) => c.name,
    getSecondary: (c) => c.description,
    getKeywords: (c) => [c.id],
    toItem: ({ row, match }, ctx) => ({
      id: `character:${row.id}`,
      kind: "character",
      title: row.name,
      titlePositions: match.positions,
      subtitle: row.description?.trim() || undefined,
      meta: ctx.t("globalSearch.people.newChatWith"),
      icon: { avatar: row },
      score: match.score,
      action: { type: "new-chat-with-character", characterId: row.id, characterName: row.name },
    }),
    suggest: (rows, _ctx, limit) =>
      rows.slice(0, limit).map((row, index) => ({
        id: `character:${row.id}`,
        kind: "character" as const,
        title: row.name,
        subtitle: row.description?.trim() || undefined,
        icon: { avatar: row },
        score: 1 - index / (limit + 1),
        action: {
          type: "new-chat-with-character" as const,
          characterId: row.id,
          characterName: row.name,
        },
      })),
  })
}

export function createTeamsProvider(deps: Pick<PeopleProviderDeps, "listTeams">) {
  return createListProvider<Team>({
    id: TEAMS_PROVIDER_ID,
    kind: "team",
    load: () => deps.listTeams(),
    getTitle: (t) => t.name,
    getSecondary: (t) => t.description,
    getKeywords: (t) => [t.id],
    toItem: ({ row, match }, ctx) => ({
      id: `team:${row.id}`,
      kind: "team",
      title: row.name,
      titlePositions: match.positions,
      subtitle: row.description?.trim() || undefined,
      meta: ctx.t("globalSearch.people.members", { count: row.members?.length ?? 0 }),
      icon: { avatar: row },
      score: match.score,
      action: { type: "switch-guild", kind: "team", teamId: row.id },
    }),
  })
}

export const charactersProvider = createCharactersProvider({ listCharacters })
export const teamsProvider = createTeamsProvider({ listTeams })
