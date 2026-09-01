/**
 * Squads (ADR-0129 x ADR-0140): the executors a conversation can be handed to.
 *
 * `teamsProvider` next door is a DIFFERENT Team. It reads the Dexie `teams`
 * table, a guild of Characters, and its action switches guild. A Squad is an
 * `AgentTeam` in the zustand store, and typing its name found nothing at all
 * before this: the only way ⌘K reached Squads was the `/squads` page itself,
 * which answers "show me the list", not "open the Review Crew".
 *
 * Workspace-scoped by `projectId`, which is `filter` rather than `demote`
 * because a Squad genuinely belongs to a workspace: `createTeam` stamps the
 * active project and the store purges per project. Out of scope it is noise,
 * not a preference. Reusable templates carry no `projectId`, and `byProjectId`
 * already treats an absent owner as "everywhere", which is what a template is.
 */

import { UsersIcon } from "lucide-react"

import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AgentTeam, AgentTeammate } from "@/types/agent/agent-team"

import { createListProvider } from "./list-provider"
import { byProjectId } from "../workspace-scope"

export const SQUADS_PROVIDER_ID = "builtin.squads"

/** The identity subset the palette needs, never the whole team row. */
export interface SquadSearchRow {
  id: string
  name: string
  description?: string
  status: AgentTeam["status"]
  memberCount: number
  projectId?: string
}

export interface SquadsProviderDeps {
  listSquads: () => readonly AgentTeam[]
  listTeammates: () => readonly AgentTeammate[]
}

export const DEFAULT_SQUADS_PROVIDER_DEPS: SquadsProviderDeps = {
  listSquads: () => Object.values(useAgentTeamStore.getState().teams),
  listTeammates: () => Object.values(useAgentTeamStore.getState().teammates),
}

export function loadSquadSearchRows(
  deps: SquadsProviderDeps = DEFAULT_SQUADS_PROVIDER_DEPS
): SquadSearchRow[] {
  // A synchronous store read can throw before the store has hydrated, and a
  // provider's `load` is cached, so a rejection would blank Squads from the
  // palette until the TTL expires rather than for one keystroke.
  let squads: readonly AgentTeam[]
  let teammates: readonly AgentTeammate[]
  try {
    squads = deps.listSquads()
    teammates = deps.listTeammates()
  } catch (error) {
    console.warn("global-search/squads: store read failed, listing none", error)
    return []
  }

  const memberCounts = new Map<string, number>()
  for (const member of teammates) {
    memberCounts.set(member.teamId, (memberCounts.get(member.teamId) ?? 0) + 1)
  }

  return squads.map((squad) => ({
    id: squad.id,
    name: squad.name,
    ...(squad.description ? { description: squad.description } : {}),
    status: squad.status,
    memberCount: memberCounts.get(squad.id) ?? 0,
    ...(squad.projectId ? { projectId: squad.projectId } : {}),
  }))
}

export function createSquadsProvider(deps: SquadsProviderDeps = DEFAULT_SQUADS_PROVIDER_DEPS) {
  return createListProvider<SquadSearchRow>({
    id: SQUADS_PROVIDER_ID,
    kind: "squad",
    load: () => loadSquadSearchRows(deps),
    getTitle: (row) => row.name,
    getSecondary: (row) => row.description,
    // The id is searchable so a `/squads?id=` link pasted from a run row or a
    // notification resolves to the Squad it names.
    getKeywords: (row) => [row.id, row.status],
    workspaceScope: { mode: "filter", belongs: byProjectId((row) => row.projectId) },
    toItem: ({ row, match }, ctx) => ({
      id: `squad:${row.id}`,
      kind: "squad" as const,
      title: row.name,
      titlePositions: match.positions,
      subtitle: row.description,
      meta: ctx.t("squads.fleet.memberCount", { count: row.memberCount }),
      icon: { lucide: UsersIcon },
      score: match.score,
      action: { type: "navigate", href: `/squads?id=${encodeURIComponent(row.id)}` },
    }),
  })
}

export const squadsProvider = createSquadsProvider()
