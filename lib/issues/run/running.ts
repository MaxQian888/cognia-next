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
import { listActiveIssueRunIssueIds } from "@/lib/db/issue-runs"
import { actorKey } from "@/lib/issues/board-model"
import type { IssueViewerContext } from "@/lib/issues/views"

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
