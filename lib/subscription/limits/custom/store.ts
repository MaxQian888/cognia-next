// Pure helpers for the user-defined custom limits sources list. The array
// itself is persisted in `appSettings.customLimitsSources` (the settings
// store); these functions just normalize and mutate a list immutably so the
// store layer and the settings UI share one validated shape.

import type { CustomLimitsSource, DescriptorExtract, WindowSpec } from "@/types/subscription"

/** Stable id generator that doesn't need `crypto` (sufficient for a local list). */
export function newCustomSourceId(seed: number): string {
  return `cls-${seed.toString(36)}-${Math.floor(seed % 1000).toString(36)}`
}

/** A blank balance-kind source the editor form starts from. */
export function emptyCustomSource(id: string): CustomLimitsSource {
  return {
    id,
    name: "",
    baseUrl: "",
    token: "",
    request: { path: "" },
    extract: { kind: "balance", remainingPath: "" },
  }
}

/** Trim user input and guarantee a usable extract shape. */
export function normalizeCustomSource(src: CustomLimitsSource): CustomLimitsSource {
  const extract: DescriptorExtract =
    src.extract.kind === "window"
      ? { ...src.extract, windows: src.extract.windows.map((w) => ({ ...w })) }
      : { ...src.extract }
  return {
    ...src,
    id: src.id.trim(),
    name: src.name.trim(),
    baseUrl: src.baseUrl.trim().replace(/\/+$/, ""),
    token: src.token.trim(),
    request: {
      ...src.request,
      path: src.request.path.trim(),
    },
    extract,
  }
}

/**
 * A window is runnable when it carries a usable utilization spec — either a
 * pre-computed `usedPctPath`, or a count pair (`totalPath` + `usedPath` or
 * `remainingPath`) the engine can divide into a percent. Mirrors
 * `resolveUtilization` in the descriptor engine, so a custom Coding Plan source
 * shaped like the built-in MiniMax (used/total) or Kimi-coding (remaining/total)
 * descriptors isn't dropped as "incomplete". `select` and the reset fields are
 * orthogonal and don't gate this check.
 */
function windowHasUtilization(w: WindowSpec): boolean {
  if (w.usedPctPath?.trim()) return true
  if (w.totalPath?.trim() && (w.usedPath?.trim() || w.remainingPath?.trim())) return true
  return false
}

/**
 * A source is runnable when it has the minimum a query needs: a name, baseUrl,
 * token, request path, and at least one extractable field.
 */
export function isCustomSourceComplete(src: CustomLimitsSource): boolean {
  const s = normalizeCustomSource(src)
  if (!s.name || !s.baseUrl || !s.token || !s.request.path) return false
  if (s.extract.kind === "balance") {
    return Boolean(s.extract.totalPath || s.extract.usedPath || s.extract.remainingPath)
  }
  return s.extract.windows.length > 0 && s.extract.windows.every(windowHasUtilization)
}

/** Insert or replace a source by id, returning a new array. */
export function upsertCustomSource(
  list: readonly CustomLimitsSource[],
  src: CustomLimitsSource
): CustomLimitsSource[] {
  const normalized = normalizeCustomSource(src)
  const idx = list.findIndex((s) => s.id === normalized.id)
  if (idx === -1) return [...list, normalized]
  const next = list.slice()
  next[idx] = normalized
  return next
}

/** Remove a source by id, returning a new array. */
export function removeCustomSource(
  list: readonly CustomLimitsSource[],
  id: string
): CustomLimitsSource[] {
  return list.filter((s) => s.id !== id)
}
