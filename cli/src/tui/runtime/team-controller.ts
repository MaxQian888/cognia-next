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

/**
 * Render a team's static definition as a markdown document for the pager — the
 * orchestration mode (+ supervisor lead), description, and a member table with
 * each slot's role, character, and any model / tool / MCP overrides. This is the
 * persisted *definition*; live run monitoring stays in the desktop app (team
 * execution is renderer-only in the CLI).
 */
export function formatTeamDoc(team: Team): string {
  const count = team.members.length
  const leader =
    team.orchestration === "supervisor" && team.supervisorCharacterId
      ? ` · lead \`${team.supervisorCharacterId}\``
      : ""
  const lines: string[] = [
    `# ${team.name}`,
    "",
    `${team.orchestration}${leader} · ${count} member${count === 1 ? "" : "s"}`,
  ]
  if (team.description) lines.push("", `> ${team.description}`)
  lines.push("", "## Members")
  team.members.forEach((m, i) => {
    const isLead = !!team.supervisorCharacterId && m.characterId === team.supervisorCharacterId
    const parts = [
      `${i + 1}. **${m.role ?? "member"}**${isLead ? " 👑" : ""} · \`${m.characterId}\``,
    ]
    if (m.modelOverride) parts.push(`model: ${m.modelOverride}`)
    if (m.allowedToolsOverride?.length) parts.push(`tools: ${m.allowedToolsOverride.join(", ")}`)
    if (m.mcpServerIdsOverride?.length) parts.push(`mcp: ${m.mcpServerIdsOverride.join(", ")}`)
    lines.push(parts.join(" · "))
  })
  lines.push("", "_Live run monitoring runs in the desktop app._")
  return lines.join("\n")
}

export async function teamShow(id: string, deps: TeamDeps): Promise<void> {
  await dbOf(deps)()
  const team = await (deps.get ?? getTeam)(id)
  if (!team) {
    deps.dispatch({ type: "NOTICE", message: `Team ${id} not found.` })
    return
  }
  deps.dispatch({
    type: "OVERLAY_OPEN",
    overlay: {
      kind: "document",
      title: `Team · ${team.name}`,
      body: formatTeamDoc(team),
      format: "markdown",
    },
  })
}

export function teamRunUnavailable(deps: TeamDeps): void {
  deps.dispatch({
    type: "NOTICE",
    message:
      "Team execution isn't available in the CLI yet — use /team list and /team show. Run teams from the desktop app.",
  })
}
