/**
 * CLI-side client for the desktop agent-team bridge routes
 * (`POST /api/dev/teams/{list,run,run-status}`).
 *
 * AgentTeam definitions live in the desktop renderer's Zustand store and
 * run history in the GUI's Dexie — the CLI can reach neither, so `/team
 * run` dispatches the run on the desktop and polls its status here. Every
 * helper degrades to `null` (or a structured error) when the desktop is
 * unreachable; the run itself continues on the desktop even if the CLI
 * stops polling.
 */

import { detectDesktop, DEV_TOKEN_HEADER, type HandoffClientDeps } from "../handoff/client"
import type { BridgeEndpoint } from "../handoff/endpoint"

export const TEAMS_LIST_PATH = "/api/dev/teams/list"
export const TEAMS_RUN_PATH = "/api/dev/teams/run"
export const TEAMS_RUN_STATUS_PATH = "/api/dev/teams/run-status"
const REQUEST_TIMEOUT_MS = 10_000

export interface DesktopTeamRow {
  id: string
  name: string
  status: string
  objective: string
  teammateCount: number
}

export interface DesktopTeamRunStatus {
  run?: {
    runId: string
    status: string
    startedAt: number
    completedAt?: number
    error?: string
  }
  events?: Array<{ ts: number; type: string; stepId?: string; message?: string }>
}

export interface DesktopTeamClientDeps extends HandoffClientDeps {
  /** Pre-resolved endpoint (skips detectDesktop). */
  endpoint?: BridgeEndpoint | null
  timeoutMs?: number
}

async function post(
  path: string,
  payload: Record<string, unknown>,
  deps: DesktopTeamClientDeps
): Promise<{ endpoint: BridgeEndpoint; body: unknown } | null> {
  const endpoint = deps.endpoint !== undefined ? deps.endpoint : await detectDesktop(deps)
  if (!endpoint) return null
  const doFetch = deps.fetch ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? REQUEST_TIMEOUT_MS)
  try {
    const res = await doFetch(`${endpoint.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [DEV_TOKEN_HEADER]: endpoint.devToken,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    if (!res.ok) return null
    return { endpoint, body: await res.json() }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Unwrap the bridge envelope `{ ok, result }` + the renderer's own `{ ok }`. */
function unwrap<T extends { ok?: boolean }>(body: unknown): T | null {
  const envelope = body as { ok?: boolean; result?: T } | undefined
  if (!envelope?.ok || !envelope.result || envelope.result.ok !== true) return null
  return envelope.result
}

/** List the desktop's agent teams; `null` when the desktop is unreachable. */
export async function listDesktopTeams(
  deps: DesktopTeamClientDeps = {}
): Promise<DesktopTeamRow[] | null> {
  const res = await post(TEAMS_LIST_PATH, {}, deps)
  if (!res) return null
  const result = unwrap<{ ok: boolean; teams?: DesktopTeamRow[] }>(res.body)
  return result?.teams ?? null
}

export interface StartDesktopTeamRunResult {
  ok: boolean
  error?: string
}

/** Start a team run on the desktop (fire-and-forget there; poll for status). */
export async function startDesktopTeamRun(
  teamId: string,
  deps: DesktopTeamClientDeps = {}
): Promise<StartDesktopTeamRunResult> {
  const res = await post(TEAMS_RUN_PATH, { teamId }, deps)
  if (!res) return { ok: false, error: "desktop unreachable" }
  const envelope = res.body as {
    ok?: boolean
    result?: { ok?: boolean; error?: string }
    error?: string
  }
  if (envelope?.ok && envelope.result?.ok) return { ok: true }
  return {
    ok: false,
    error: envelope?.result?.error ?? envelope?.error ?? "team run rejected",
  }
}

/** Poll the newest synthesized run + events since `sinceTs`; `null` on failure. */
export async function fetchDesktopTeamRunStatus(
  teamId: string,
  sinceTs: number,
  deps: DesktopTeamClientDeps = {}
): Promise<DesktopTeamRunStatus | null> {
  const res = await post(TEAMS_RUN_STATUS_PATH, { teamId, sinceTs }, deps)
  if (!res) return null
  return unwrap<{ ok: boolean } & DesktopTeamRunStatus>(res.body)
}
