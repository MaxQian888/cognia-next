/**
 * Viewer-side helpers for the run bridge: which issues have an active run,
 * and which actor keys count as "my agents and squads".
 *
 * Both used to be hard-coded in `components/issues/issue-console.tsx`
 * (`new Set()` and `agentKeys: []`), which pinned the "N agents working" pill
 * to zero and the "My agents" view to empty. This module is the live source.
 *
 * "My agents" in a single-user app = every agent and team that exists locally
 * (grill decision Q9): the human is the only principal, so every Character
 * and every AgentTeam is theirs. Keys use `actorKey` (`agent:<id>` /
 * `team:<id>`) so they compare against `UnifiedIssueItem.assignee` directly.
 */

import { listCharacters } from "@/lib/db/characters"
import { listActiveIssueRunIssueIds, listIssueRuns } from "@/lib/db/issue-runs"
import { AGENT_TEAM_RUN_ADAPTER_ID } from "@/lib/issues/run/agent-team-adapter"
import { actorKey } from "@/lib/issues/board-model"
import type { IssueViewerContext } from "@/lib/issues/views"
import type { IssueRun, IssueRunStatus } from "@/types/issues"

/** `actorKey` for the local human — the only human principal. */
export const SELF_ACTOR_KEY = "human:self"

export interface ViewerAgentKeysDeps {
  listCharacterIds: () => Promise<string[]>
  listTeamIds: () => Promise<string[]>
}

async function defaultListTeamIds(): Promise<string[]> {
  const { useAgentTeamStore } = await import("@/stores/agent/agent-team-store")
  return Object.keys(useAgentTeamStore.getState().teams)
}

const defaultDeps: ViewerAgentKeysDeps = {
  listCharacterIds: async () => (await listCharacters()).map((character) => character.id),
  listTeamIds: defaultListTeamIds,
}

/** Every `agent:<characterId>` and `team:<teamId>` the viewer owns. */
export async function viewerAgentKeys(deps: ViewerAgentKeysDeps = defaultDeps): Promise<string[]> {
  const [characterIds, teamIds] = await Promise.all([deps.listCharacterIds(), deps.listTeamIds()])
  const keys = new Set<string>()
  for (const id of characterIds) {
    const key = actorKey({ kind: "agent", id })
    if (key) keys.add(key)
  }
  for (const id of teamIds) {
    const key = actorKey({ kind: "team", id })
    if (key) keys.add(key)
  }
  return [...keys].sort()
}

/** The full viewer context for `applyViewScope`. */
export async function loadIssueViewerContext(
  deps: ViewerAgentKeysDeps = defaultDeps
): Promise<IssueViewerContext> {
  return { selfKey: SELF_ACTOR_KEY, agentKeys: await viewerAgentKeys(deps) }
}

/** Local issue ids with an active run in the workspace — feeds `issueRunHint`. */
export async function listRunningIssueIds(projectId: string): Promise<Set<string>> {
  return listActiveIssueRunIssueIds(projectId)
}

/** The Squad run an issue was dispatched to, for the board's squad chip. */
export interface SquadRunRef {
  runId: string
  teamId: string
  /** Display name of the team, when it still exists locally. */
  teamName?: string
  status: IssueRunStatus
}

export interface SquadRunLookupDeps {
  listRuns: (projectId: string) => Promise<IssueRun[]>
  /** Team name by id. Absent teams simply have no name. */
  teamNameOf: (teamId: string) => Promise<string | undefined>
}

async function defaultTeamNameOf(teamId: string): Promise<string | undefined> {
  const { useAgentTeamStore } = await import("@/stores/agent/agent-team-store")
  return useAgentTeamStore.getState().teams[teamId]?.name
}

const defaultSquadRunDeps: SquadRunLookupDeps = {
  listRuns: (projectId) => listIssueRuns({ projectId }),
  teamNameOf: defaultTeamNameOf,
}

/**
 * Newest `agent-team` run per LOCAL issue id in the workspace.
 *
 * Every run of the issue counts, finished ones included: the link from an
 * issue to the squad that worked it is the thing a reader wants after the run
 * as much as during it. `listIssueRuns` is newest-first, so the first row seen
 * for an issue wins.
 */
export async function listSquadRunsByIssue(
  projectId: string,
  deps: SquadRunLookupDeps = defaultSquadRunDeps
): Promise<Map<string, SquadRunRef>> {
  const runs = await deps.listRuns(projectId)
  const byIssue = new Map<string, SquadRunRef>()
  for (const run of runs) {
    if (run.adapterId !== AGENT_TEAM_RUN_ADAPTER_ID || byIssue.has(run.issueId)) continue
    byIssue.set(run.issueId, { runId: run.id, teamId: run.targetId, status: run.status })
  }
  const teamIds = [...new Set([...byIssue.values()].map((ref) => ref.teamId))]
  const names = await Promise.all(teamIds.map((teamId) => deps.teamNameOf(teamId)))
  const nameById = new Map(teamIds.map((teamId, index) => [teamId, names[index]]))
  for (const ref of byIssue.values()) {
    const name = nameById.get(ref.teamId)
    if (name) ref.teamName = name
  }
  return byIssue
}
