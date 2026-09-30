/**
 * Tool-owned audit projection for the External Bridge (roadmap 2026-09-29,
 * Phase 1).
 *
 * The audit log used to record only the tool name, scope and outcome — never
 * arguments, which kept it safe but made "which file did that client write?"
 * unanswerable. A tool may now declare a projection: the handful of argument
 * fields that identify what it touched. The tool definition owns it, so a new
 * argument never leaks into the log by default, and this module enforces the
 * shape whatever a projection returns:
 *
 *  - only string / finite number / boolean leaves survive; objects, arrays and
 *    everything else are dropped, never stringified;
 *  - at most {@link MAX_PROJECTION_FIELDS} fields, each string cut to
 *    {@link MAX_PROJECTION_STRING} characters;
 *  - a projection that throws or returns nothing usable records `undefined`
 *    ("unprojectable → empty"), never the raw params.
 *
 * Pure and dependency-free: the MCP sidecar bundle replaces `./audit-log` with
 * a host proxy, so the projection has to be computed before the call leaves.
 */

export type AuditProjection = Record<string, string | number | boolean>

export const MAX_PROJECTION_FIELDS = 8
export const MAX_PROJECTION_STRING = 200

export function auditProjection(
  project: (() => Record<string, unknown>) | undefined
): AuditProjection | undefined {
  if (!project) return undefined
  let raw: unknown
  try {
    raw = project()
  } catch {
    return undefined
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const out: AuditProjection = {}
  let fields = 0
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (fields >= MAX_PROJECTION_FIELDS) break
    if (typeof value === "string") {
      out[key] = value.slice(0, MAX_PROJECTION_STRING)
    } else if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value
    } else if (typeof value === "boolean") {
      out[key] = value
    } else {
      continue
    }
    fields += 1
  }
  return fields > 0 ? out : undefined
}
