/**
 * `/team` controller — list and inspect agent teams (read-only) by reusing
 * `lib/db/teams`. Team EXECUTION is deferred: `runTeam` needs the renderer-only
 * `configureAgentTeamRuntime` Zustand binding, so `/team run` explains the
 * boundary instead of silently failing.
 */
import { getTeam, listTeams } from "@/lib/db/teams"
import type { Team } from "@/lib/claude/types"

import { ensureCliDb } from "../../db/bootstrap"
import type { TuiAction } from "../state/types"

export interface TeamDeps {
  dispatch: (action: TuiAction) => void
  ensureDb?: () => Promise<unknown>
  list?: () => Promise<Team[]>
  get?: (id: string) => Promise<Team | undefined>
}

const dbOf = (d: TeamDeps) => d.ensureDb ?? (() => ensureCliDb())

export async function teamList(deps: TeamDeps): Promise<void> {
  await dbOf(deps)()
  const teams = await (deps.list ?? listTeams)()
  if (teams.length === 0) {
    deps.dispatch({ type: "NOTICE", message: "No agent teams found." })
    return
  }
  deps.dispatch({
    type: "OVERLAY_OPEN",
    overlay: {
      kind: "select",
      title: "Inspect team",
      items: teams.map((t) => ({
        id: t.id,
        label: t.name,
        hint: `${t.members.length} members`,
      })),
      index: 0,
      onSelectCommand: "team show",
    },
  })
}

export async function teamShow(id: string, deps: TeamDeps): Promise<void> {
  await dbOf(deps)()
  const team = await (deps.get ?? getTeam)(id)
  if (!team) {
    deps.dispatch({ type: "NOTICE", message: `Team ${id} not found.` })
    return
  }
  const desc = team.description ? ` — ${team.description}` : ""
  const members = team.members.map((m, i) => `  ${i + 1}. ${m.characterId}`).join("\n")
  deps.dispatch({
    type: "NOTICE",
    message: `Team "${team.name}" (${team.orchestration})${desc}\n${members}`,
  })
}

export function teamRunUnavailable(deps: TeamDeps): void {
  deps.dispatch({
    type: "NOTICE",
    message:
      "Team execution isn't available in the CLI yet — use /team list and /team show. Run teams from the desktop app.",
  })
}
