/**
 * `/team` controller — list and inspect chat teams (read-only, `lib/db/teams`)
 * and RUN desktop AgentTeams by dispatching to the running desktop app over
 * the CLI bridge. The runnable entity lives in the desktop renderer's store
 * (never in the CLI's own Dexie), so `/team run` lists the DESKTOP's teams,
 * starts the run there, and polls its status into the transcript. A stopped
 * poll (Esc) never stops the desktop run.
 */
import { getTeam, listTeams } from "@/lib/db/teams"
import type { AppSettings, ChatSession, Team } from "@cognia/agent-config-types"
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
import {
  fetchDesktopTeamRunStatus,
  listDesktopTeams,
  startDesktopTeamRun,
} from "../../team/desktop-client"

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

const DESKTOP_UNREACHABLE_MESSAGE =
  "Team execution requires the Cognia desktop app — start Cognia, then retry /team run."

/** Terminal run statuses — polling stops when one is reached. */
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled"])

const POLL_INTERVAL_MS = 1_500
/** Polling backstop (poll ticks). At 1.5 s per tick this is ~1 hour; the
 * desktop run continues regardless — only the CLI's live view stops. */
const MAX_POLL_TICKS = 2_400

export interface TeamRunDeps {
  dispatch: (action: TuiAction) => void
  /** Aborting stops the CLI's polling only — the desktop run continues. */
  signal?: AbortSignal
  // ── injectable seams (default to the real impls; faked in tests) ──
  listDesktop?: typeof listDesktopTeams
  startRun?: typeof startDesktopTeamRun
  fetchStatus?: typeof fetchDesktopTeamRunStatus
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * `/team run [teamId]` — run a DESKTOP AgentTeam from the CLI. Without an id,
 * lists the desktop's teams in a picker (re-entering with the selection).
 * With an id, dispatches the run on the desktop and streams status/events
 * into the transcript as NOTICE lines until the run reaches a terminal
 * status (or the user stops watching).
 */
export async function teamRun(teamId: string, deps: TeamRunDeps): Promise<void> {
  const listDesktop = deps.listDesktop ?? listDesktopTeams
  const startRun = deps.startRun ?? startDesktopTeamRun
  const fetchStatus = deps.fetchStatus ?? fetchDesktopTeamRunStatus
  const sleep = deps.sleep ?? defaultSleep

  const id = teamId.trim()
  if (!id) {
    const teams = await listDesktop()
    if (teams === null) {
      deps.dispatch({ type: "NOTICE", message: DESKTOP_UNREACHABLE_MESSAGE })
      return
    }
    if (teams.length === 0) {
      deps.dispatch({
        type: "NOTICE",
        message: "No agent teams on the desktop — create one in the Agent Teams workspace first.",
      })
      return
    }
    deps.dispatch({
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "select",
        title: "Run team (on desktop)",
        items: teams.map((t) => ({
          id: t.id,
          label: t.name,
          hint: `${t.teammateCount} members · ${t.status}`,
        })),
        index: 0,
        onSelectCommand: "team run",
      },
    })
    return
  }

  const started = await startRun(id)
  if (!started.ok) {
    const message =
      started.error === "desktop unreachable"
        ? DESKTOP_UNREACHABLE_MESSAGE
        : `Team run failed to start: ${started.error ?? "unknown error"}`
    deps.dispatch({ type: "NOTICE", message })
    return
  }
  deps.dispatch({
    type: "NOTICE",
    message: `Team run dispatched on the desktop (${id}) — watching progress (Esc stops watching; the run continues).`,
  })

  let sinceTs = 0
  let lastStatus = ""
  for (let tick = 0; tick < MAX_POLL_TICKS; tick++) {
    if (deps.signal?.aborted) {
      deps.dispatch({
        type: "NOTICE",
        message: "Stopped watching — the team run continues on the desktop.",
      })
      return
    }
    await sleep(POLL_INTERVAL_MS)
    const status = await fetchStatus(id, sinceTs)
    if (!status) continue // transient bridge hiccup — keep watching
    for (const event of status.events ?? []) {
      sinceTs = Math.max(sinceTs, event.ts)
      if (event.message) {
        deps.dispatch({ type: "NOTICE", message: `[team] ${event.message}` })
      }
    }
    const run = status.run
    if (!run) continue // run row not visible yet
    if (run.status !== lastStatus) {
      lastStatus = run.status
      deps.dispatch({ type: "NOTICE", message: `[team] run ${run.runId}: ${run.status}` })
    }
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      const suffix = run.error ? ` — ${run.error}` : ""
      deps.dispatch({
        type: "NOTICE",
        message: `Team run finished: ${run.status}${suffix}. Full history in the desktop workspace.`,
      })
      return
    }
  }
  deps.dispatch({
    type: "NOTICE",
    message: "Stopped watching after the polling limit — the run continues on the desktop.",
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
