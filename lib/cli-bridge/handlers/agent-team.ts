/**
 * Renderer handlers for the CLI bridge's agent-team commands
 * (`POST /api/dev/teams/{list,run,run-status}`).
 *
 * AgentTeam definitions live in the renderer's Zustand store (persisted to
 * GUI localStorage) and run history in the GUI's Dexie `workflowRuns` — the
 * CLI process can reach neither, so `/team run` in the TUI dispatches here.
 *
 * PII posture: list rows carry name/objective through `redactText` (same
 * outward gate as the external bridge's `team_list`); run-status events are
 * projected WITHOUT step payloads, and `run_log` messages are forwarded only
 * when `hasNoLeakingPii` passes.
 */

export interface AgentTeamListRow {
  id: string
  name: string
  status: string
  objective: string
  teammateCount: number
}

export interface AgentTeamListResult {
  ok: boolean
  teams?: AgentTeamListRow[]
  error?: string
}

export async function agentTeamList(): Promise<AgentTeamListResult> {
  try {
    const [{ useAgentTeamStore }, { redactText }] = await Promise.all([
      import("@/stores/agent/agent-team-store"),
      import("@cognia/redact"),
    ])
    const teams = Object.values(useAgentTeamStore.getState().teams).map((team) => ({
      id: team.id,
      name: redactText(team.name ?? "").redacted,
      status: team.status,
      objective: redactText(team.task ?? "").redacted,
      teammateCount: team.teammateIds.length,
    }))
    return { ok: true, teams }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export interface AgentTeamRunResult {
  ok: boolean
  teamId?: string
  /** True when the run was dispatched (fire-and-forget). */
  started?: boolean
  error?: string
}

export async function agentTeamRun(payload: Record<string, unknown>): Promise<AgentTeamRunResult> {
  const teamId = typeof payload.teamId === "string" ? payload.teamId : ""
  if (!teamId) return { ok: false, error: "agent_team_run requires a teamId" }
  try {
    const { agentTeamManager } = await import("@/lib/ai/agent/agent-team")
    if (!agentTeamManager.get(teamId)) {
      return { ok: false, error: `team ${teamId} not found` }
    }
    // Fire-and-forget, mirroring remote-control's team.dispatch: `start`
    // awaits the whole run, and the CLI polls run-status instead. Origin
    // "remote" applies the headless gate policy. The runtime's inflight
    // guard throws "already running" synchronously-ish — surface that via
    // the catch below only when it rejects before this handler returns.
    void agentTeamManager
      .start(teamId, {
        origin: "remote",
        ...(typeof payload.ultracode === "boolean" ? { ultracode: payload.ultracode } : {}),
      })
      .catch(() => {
        // Terminal failures surface through run-status polling.
      })
    return { ok: true, teamId, started: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export interface AgentTeamRunStatusResult {
  ok: boolean
  run?: {
    runId: string
    status: string
    startedAt: number
    completedAt?: number
    error?: string
  }
  /** Step-scoped events since `sinceTs`, without payloads. */
  events?: Array<{ ts: number; type: string; stepId?: string; message?: string }>
  error?: string
}

export async function agentTeamRunStatus(
  payload: Record<string, unknown>
): Promise<AgentTeamRunStatusResult> {
  const teamId = typeof payload.teamId === "string" ? payload.teamId : ""
  if (!teamId) return { ok: false, error: "agent_team_run_status requires a teamId" }
  const sinceTs = typeof payload.sinceTs === "number" ? payload.sinceTs : 0

  try {
    const [{ getDb }, { isSynthesizedTeamRunPayload }, { hasNoLeakingPii }] = await Promise.all([
      import("@/lib/db/schema"),
      import("@/components/agent/team/runs-list"),
      import("@cognia/redact"),
    ])
    const db = getDb()
    const all = await db.workflowRuns
      .where("triggerKind")
      .equals("trigger.team")
      .reverse()
      .sortBy("startedAt")
    // Reuse the runs-list filter: synthesized team runs only — never the
    // "on team finished" fan-out runs that share the trigger kind.
    const run = all.find((r) => isSynthesizedTeamRunPayload(r.triggerPayload, teamId))
    if (!run) return { ok: true }

    const rows = await db.workflowRunEvents.where("runId").equals(run.id).sortBy("ts")
    const events = rows
      .filter((e) => e.ts > sinceTs)
      .map((e) => {
        // Forward run_log text only when it clears the PII gate; every
        // other event is projected without its payload.
        let message: string | undefined
        if (e.type === "run_log") {
          const raw = (e.payload as { message?: unknown } | undefined)?.message
          if (typeof raw === "string" && hasNoLeakingPii(raw)) message = raw
        }
        return {
          ts: e.ts,
          type: String(e.type),
          ...(e.stepId ? { stepId: e.stepId } : {}),
          ...(message ? { message } : {}),
        }
      })

    return {
      ok: true,
      run: {
        runId: run.id,
        status: String(run.status),
        startedAt: run.startedAt,
        ...(run.completedAt ? { completedAt: run.completedAt } : {}),
        ...(run.error?.message && hasNoLeakingPii(run.error.message)
          ? { error: run.error.message }
          : {}),
      },
      events,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
