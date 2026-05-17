/**
 * agent-team-compat
 *
 * Bridges the agent-team store to the runtime engine + lightly normalizes
 * config/task inputs so they don't carry obviously-invalid values into the
 * store.
 *
 * Was a no-op stub before the runtime landed; now `dispatchAgentTeam`
 * actually starts a team via `agentTeamManager.start()`.
 */

import { agentTeamManager } from "./agent-team"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"

export interface AgentTeamCompatDispatchOptions {
  teamId: string
  task?: string
  metadata?: Record<string, unknown>
}

export interface AgentTeamCompatDispatchResult {
  ok: boolean
  reason?: string
}

/**
 * Start a team's lifecycle. Returns `{ ok: true }` on a successful run,
 * `{ ok: false, reason }` on validation / runtime errors. The promise
 * resolves once the runtime returns — for long-running teams the caller
 * may prefer to start them via `agentTeamManager.start()` directly.
 */
export async function dispatchAgentTeam(
  options: AgentTeamCompatDispatchOptions
): Promise<AgentTeamCompatDispatchResult> {
  if (!options || typeof options.teamId !== "string" || options.teamId.length === 0) {
    return { ok: false, reason: "teamId is required" }
  }
  try {
    await agentTeamManager.start(options.teamId)
    // F-path runtime mirrors terminal result onto team.status. Translate
    // failed/cancelled into ok=false so legacy callers see the failure
    // even though start() itself didn't throw.
    const team = useAgentTeamStore.getState().getTeam(options.teamId)
    if (!team) return { ok: false, reason: `team ${options.teamId} not found` }
    if (team.status === "failed" || team.status === "cancelled") {
      return { ok: false, reason: `run ended ${team.status}` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

export const agentTeamCompat = {
  dispatch: dispatchAgentTeam,
}

/**
 * Light-weight normalizer for AgentTeamConfig-shaped objects. Trims string
 * fields; clamps obviously-bad numeric ones; otherwise returns the input
 * untouched. Non-object inputs are passed through unchanged so this stays
 * a safe identity for primitive callers.
 *
 * The signature is generic so the store can call it on either a full
 * `AgentTeam` (in `createTeam` / `upsertTeam`) or a partial config
 * (in `updateTeamConfig`) without casting.
 */
export function normalizeAgentTeamConfig<T>(config: T): T {
  if (!config || typeof config !== "object") return config
  const src = config as Record<string, unknown>
  let dirty = false
  const next: Record<string, unknown> = { ...src }

  // Trim known string-ish fields.
  for (const key of ["name", "description", "task"] as const) {
    const value = src[key]
    if (typeof value === "string") {
      const trimmed = value.trim()
      if (trimmed !== value) {
        next[key] = trimmed
        dirty = true
      }
    }
  }

  // Clamp known numeric fields (sub-objects use the same approach).
  const config_ = src.config as Record<string, unknown> | undefined
  if (config_ && typeof config_ === "object") {
    const cfg = { ...config_ }
    let cfgDirty = false
    if (typeof cfg.maxTeammates === "number" && cfg.maxTeammates < 1) {
      cfg.maxTeammates = 1
      cfgDirty = true
    }
    if (typeof cfg.maxConcurrentTeammates === "number" && cfg.maxConcurrentTeammates < 1) {
      cfg.maxConcurrentTeammates = 1
      cfgDirty = true
    }
    if (typeof cfg.tokenBudget === "number" && cfg.tokenBudget < 0) {
      cfg.tokenBudget = 0
      cfgDirty = true
    }
    if (cfgDirty) {
      next.config = cfg
      dirty = true
    }
  } else {
    // Top-level numeric clamps for partial-config callers.
    if (typeof src.maxTeammates === "number" && src.maxTeammates < 1) {
      next.maxTeammates = 1
      dirty = true
    }
    if (typeof src.maxConcurrentTeammates === "number" && src.maxConcurrentTeammates < 1) {
      next.maxConcurrentTeammates = 1
      dirty = true
    }
    if (typeof src.tokenBudget === "number" && src.tokenBudget < 0) {
      next.tokenBudget = 0
      dirty = true
    }
  }

  return (dirty ? next : config) as T
}

/**
 * Light-weight normalizer for task-shaped objects. Trims `title` /
 * `description` / `expectedOutput`; clamps negative `order` / `priority`-ish
 * numerics. Non-object inputs pass through unchanged.
 */
export function normalizeAgentTeamTask<T>(task: T): T {
  if (!task || typeof task !== "object") return task
  const src = task as Record<string, unknown>
  let dirty = false
  const next: Record<string, unknown> = { ...src }

  for (const key of ["title", "description", "expectedOutput"] as const) {
    const value = src[key]
    if (typeof value === "string") {
      const trimmed = value.trim()
      if (trimmed !== value) {
        next[key] = trimmed
        dirty = true
      }
    }
  }

  if (typeof src.order === "number" && src.order < 0) {
    next.order = 0
    dirty = true
  }
  if (typeof src.retryCount === "number" && src.retryCount < 0) {
    next.retryCount = 0
    dirty = true
  }

  return (dirty ? next : task) as T
}
