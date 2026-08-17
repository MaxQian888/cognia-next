/**
 * Context-budget model for an installed Pi package set.
 *
 * The useful budget is not "number of packages" — it is always-visible
 * schemas, per-turn injected text, and spawned model contexts. Those three
 * behave so differently that collapsing them into one number would mislead:
 *
 *   - **Static** cost is paid on every request, forever, whether or not the
 *     capability is used. It also breaks prompt caching when it changes.
 *   - **Spawned contexts** are unbounded and dominate everything else — one
 *     subagent task is a fresh paid context, so a 4-tool subagent package can
 *     cost more in a single turn than every schema in the catalog combined.
 *     Folding it into a token count would understate it by orders of
 *     magnitude, so it is reported as its own dimension.
 *   - **Unknown** packages contribute an unmeasurable amount. They are counted
 *     separately rather than assumed free, because "we didn't measure it" and
 *     "it costs nothing" are very different claims to put in front of a user.
 *
 * Pure. Figures come from the curated catalog, which sources them from
 * `docs/research/pi-agent-plugin-stack-2026-08-13.md`.
 */

import type { PiCatalogEntry } from "./catalog"
import { matchPiCatalog } from "./conflicts"
import type { PiPackageSource } from "./types"

/** One package's contribution, for the per-row breakdown. */
export interface PiBudgetRow {
  id: string
  spec: string
  toolCount: number
  staticTokens: number
  spawnsContexts: boolean
}

export interface PiContextBudget {
  /** Always-visible prompt tokens across every known package. */
  staticTokens: number
  /** Always-visible tool schemas across every known package. */
  toolCount: number
  /** Packages that can start additional paid model contexts. */
  spawningPackages: PiCatalogEntry[]
  /** Installed specs absent from the curated catalog — cost unmeasured. */
  unknownSpecs: string[]
  /** Per-package breakdown, largest static cost first. */
  rows: PiBudgetRow[]
}

/**
 * Advisory ceiling for always-visible tool schemas. `pi-mcp-adapter` itself
 * warns past 75 promoted tools; this is the same order of magnitude and exists
 * so the meter has a scale rather than a bare number.
 */
export const PI_TOOL_BUDGET_ADVISORY = 40

export function computePiContextBudget(installed: readonly PiPackageSource[]): PiContextBudget {
  const { known, unknown } = matchPiCatalog(installed)

  const rows: PiBudgetRow[] = known.map((entry) => ({
    id: entry.id,
    spec: entry.spec,
    toolCount: entry.toolCount,
    staticTokens: entry.staticTokens,
    spawnsContexts: entry.spawnsContexts === true,
  }))
  rows.sort((a, b) => b.staticTokens - a.staticTokens || a.id.localeCompare(b.id))

  return {
    staticTokens: known.reduce((sum, entry) => sum + entry.staticTokens, 0),
    toolCount: known.reduce((sum, entry) => sum + entry.toolCount, 0),
    spawningPackages: known.filter((entry) => entry.spawnsContexts === true),
    unknownSpecs: unknown,
    rows,
  }
}

/** Severity for the budget meter. */
export type PiBudgetLevel = "ok" | "warn" | "over"

export function piBudgetLevel(budget: Pick<PiContextBudget, "toolCount">): PiBudgetLevel {
  if (budget.toolCount > PI_TOOL_BUDGET_ADVISORY) return "over"
  if (budget.toolCount > PI_TOOL_BUDGET_ADVISORY * 0.75) return "warn"
  return "ok"
}

/**
 * What installing `candidate` would add on top of the current set. Returns
 * zeroes for a package that is already installed, so the pre-install dialog
 * never double-counts a reinstall or version bump.
 */
export function piBudgetDelta(
  candidateSpec: string,
  installed: readonly PiPackageSource[]
): { staticTokens: number; toolCount: number; spawnsContexts: boolean } {
  const before = computePiContextBudget(installed)
  const after = computePiContextBudget([...installed, candidateSpec])
  return {
    staticTokens: after.staticTokens - before.staticTokens,
    toolCount: after.toolCount - before.toolCount,
    spawnsContexts: after.spawningPackages.length > before.spawningPackages.length,
  }
}
