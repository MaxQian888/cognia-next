import type { ProjectCoordinatorPreferences } from "@/types"
import { MAX_CONCURRENT_THREADS_LIMIT, MAX_DAILY_THREAD_CAP } from "./config"
import type { ProjectAccess } from "./project-access"

/**
 * Preferences the coordinator may change on the user's say-so
 * (`set_project_preference`). The workspace row is the one source of truth —
 * the coordinator's context shows them from there every turn, and the settings
 * dialog edits the same fields.
 */

export const PROJECT_PREFERENCE_KEYS = [
  "max_concurrent_threads",
  "propose_before_start",
  "daily_thread_cap",
  "auto_fix_pr",
] as const

export type ProjectPreferenceKey = (typeof PROJECT_PREFERENCE_KEYS)[number]

export type ParsedPreference =
  { ok: true; patch: ProjectCoordinatorPreferences } | { ok: false; error: string }

function intIn(value: unknown, min: number, max: number): number | undefined {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value
  return typeof n === "number" && Number.isInteger(n) && n >= min && n <= max ? n : undefined
}

function bool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value
  if (value === "true") return true
  if (value === "false") return false
  return undefined
}

/** Validate one key/value into a preferences patch. `null` clears a numeric limit. */
export function parseProjectPreference(key: unknown, value: unknown): ParsedPreference {
  switch (key) {
    case "max_concurrent_threads": {
      if (value === null) return { ok: true, patch: { maxConcurrentThreads: undefined } }
      const n = intIn(value, 1, MAX_CONCURRENT_THREADS_LIMIT)
      return n === undefined
        ? { ok: false, error: `value must be an integer 1-${MAX_CONCURRENT_THREADS_LIMIT} or null` }
        : { ok: true, patch: { maxConcurrentThreads: n } }
    }
    case "daily_thread_cap": {
      const n = intIn(value, 1, MAX_DAILY_THREAD_CAP)
      return n === undefined
        ? { ok: false, error: `value must be an integer 1-${MAX_DAILY_THREAD_CAP}` }
        : { ok: true, patch: { dailyThreadCap: n } }
    }
    case "propose_before_start":
    case "auto_fix_pr": {
      const b = bool(value)
      if (b === undefined) return { ok: false, error: "value must be true or false" }
      return {
        ok: true,
        patch: key === "auto_fix_pr" ? { autoFixPr: b } : { proposeBeforeStart: b },
      }
    }
    default:
      return { ok: false, error: `key must be one of ${PROJECT_PREFERENCE_KEYS.join(", ")}` }
  }
}

export function setProjectPreference(
  projectId: string,
  key: unknown,
  value: unknown,
  access: Pick<ProjectAccess, "updateCoordinator">
): ParsedPreference {
  const parsed = parseProjectPreference(key, value)
  if (parsed.ok) access.updateCoordinator(projectId, { preferences: parsed.patch })
  return parsed
}
