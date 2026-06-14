/**
 * `/team` controller — list and inspect agent teams (read-only) by reusing
 * `lib/db/teams`. Team EXECUTION is deferred: `runTeam` needs the renderer-only
 * `configureAgentTeamRuntime` Zustand binding, so `/team run` explains the
 * boundary instead of silently failing.
 */
import { getTeam, listTeams } from "@/lib/db/teams"
import type { AppSettings, ChatSession, Team } from "@/lib/claude/types"
import type { LlmClient } from "@/lib/twin/distill/llm"
import { getSession } from "@/lib/db/sessions"
import {
  planAutoOrchestration,
  AutoOrchestrationPiiError,
} from "@/lib/ai/agent/team/auto/auto-orchestrate"
import { renderProposalDoc } from "@/lib/ai/agent/team/auto/preview-doc"
import { buildRendererLlmClient } from "@/lib/ai/renderer-llm-client"

import { ensureCliDb } from "../../db/bootstrap"
import type { ResolvedConfig } from "../../config/schema"
import type { TuiAction } from "../state/types"
import { resolveAppSettings } from "./goal-controller"

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

/**
 * `/team auto <objective>` — auto-compose a team from an objective and render
 * the proposal (routing assessment + roster + task DAG) as a preview document.
 *
 * The planning engine (`lib/ai/agent/team/auto`) is pure and headless-capable,
 * so the full assess → compose → decompose pipeline runs in the CLI. EXECUTION
 * stays desktop-only (the renderer-bound `agentTeamManager` runtime), so the
 * doc is a preview — consistent with the `/team run` boundary.
 */
export interface TeamAutoDeps {
  dispatch: (action: TuiAction) => void
  config: ResolvedConfig
  sessionId: string
  signal?: AbortSignal
  // ── injectable seams (default to the real impls; faked in tests) ──
  ensureDb?: () => Promise<unknown>
  resolveSettings?: (sessionId: string, config: ResolvedConfig) => AppSettings | null
  getSession?: (id: string) => Promise<ChatSession | null | undefined>
  buildClient?: (
    session: ChatSession | null | undefined,
    appSettings: AppSettings | null
  ) => LlmClient | null
  plan?: typeof planAutoOrchestration
}

export async function teamAuto(objective: string, deps: TeamAutoDeps): Promise<void> {
  const trimmed = objective.trim()
  if (!trimmed) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /team auto <objective>" })
    return
  }

  await (deps.ensureDb ?? (() => ensureCliDb()))()
  const appSettings = (deps.resolveSettings ?? resolveAppSettings)(deps.sessionId, deps.config)
  const session = await (deps.getSession ?? getSession)(deps.sessionId)
  const client = (
    deps.buildClient ??
    ((s, a) => buildRendererLlmClient({ session: s, appSettings: a, featureId: "agent-team-auto" }))
  )(session, appSettings)

  if (!client) {
    deps.dispatch({
      type: "NOTICE",
      message:
        "Auto-compose needs a provider with a renderer-side API key — configure one in settings.",
    })
    return
  }

  let proposal
  try {
    proposal = await (deps.plan ?? planAutoOrchestration)({
      objective: trimmed,
      client,
      signal: deps.signal,
    })
  } catch (err) {
    const message =
      err instanceof AutoOrchestrationPiiError
        ? "Auto-compose refused: the objective still contains sensitive data after redaction."
        : `Auto-compose failed: ${err instanceof Error ? err.message : String(err)}`
    deps.dispatch({ type: "NOTICE", message })
    return
  }

  const body = `${renderProposalDoc(proposal)}\n\n---\n_Preview only — materialize and run this team from the desktop app._`
  deps.dispatch({
    type: "OVERLAY_OPEN",
    overlay: {
      kind: "document",
      title: "Auto-composed team",
      body,
      format: "markdown",
    },
  })
}
