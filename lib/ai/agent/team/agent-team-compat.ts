/**
 * agent-team-compat
 *
 * Lightly normalizes Squad config and task inputs so they do not carry
 * obviously-invalid values into the store. The store calls both of these on
 * every create and update.
 *
 * It used to carry a `dispatchAgentTeam` bridge as well, which awaited a
 * Squad's whole lifecycle and translated a terminal `failed` status into an
 * `{ ok: false }`. Nothing called it, and by the time ADR-0140 named
 * `startSquadRun` as the one dispatch funnel it was also the wrong shape: every
 * live caller starts fire-and-forget and reads progress off the run row. Two
 * ways in, one of them unreachable and neither of them the documented one, is
 * worse than one.
 */

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
