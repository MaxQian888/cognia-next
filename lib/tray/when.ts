// Tray-menu `when`-expression evaluation.
//
// The parser/evaluator now lives in `lib/plugin/context-keys/when-evaluator.ts`
// (generalized so every plugin surface can reuse it). This module is a thin
// adapter that keeps the tray's nested-`TrayStateSnapshot` lookup + the
// `platform.<os>` special-case, so existing tray code and tests keep working
// unchanged. Unknown predicates evaluate to `false`; an absent/empty
// expression means "always show".

import {
  evaluateWhenExpr,
  __resetWhenCacheForTesting as resetSharedWhenCache,
} from "@/lib/plugin/context-keys/when-evaluator"
import type { TrayStateSnapshot } from "./types"

/** Walk a nested `TrayStateSnapshot` for a dotted predicate path. */
function trayLookup(snapshot: TrayStateSnapshot, path: string[]): boolean {
  if (path[0] === "platform" && path.length === 2) {
    return snapshot.platform.os === path[1]
  }
  let cur: unknown = snapshot
  for (const segment of path) {
    if (cur == null || typeof cur !== "object") return false
    cur = (cur as Record<string, unknown>)[segment]
  }
  return Boolean(cur)
}

/**
 * Evaluate a `when` expression against a `TrayStateSnapshot`. Returns `true`
 * when the expression is absent or empty (i.e. "always show"); only an
 * explicit predicate suppresses an item.
 */
export function evaluateWhen(expr: string | undefined, snapshot: TrayStateSnapshot): boolean {
  return evaluateWhenExpr(expr, (path) => trayLookup(snapshot, path))
}

/** Test-only escape hatch — clears the shared AST cache. */
export function __resetWhenCacheForTesting(): void {
  resetSharedWhenCache()
}
