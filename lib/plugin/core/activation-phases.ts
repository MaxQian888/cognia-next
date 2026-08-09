/**
 * The seven transactional phases of a plugin activation (ADR-0096).
 *
 * `enablePluginInner` is a long operation — 10 to 45 seconds on a cold start
 * with dependencies — and until now it reported nothing but a boolean
 * "loading". These phases are the boundaries at which progress advances.
 *
 * # Why `processed` is a function of the phase name alone
 *
 * `processedForPhase` derives the count from the phase's index in the ordered
 * tuple, and nothing else. Two required properties fall out of that:
 *
 * - **Monotonicity** is structural: entering a later phase can only produce a
 *   larger number.
 * - **Skipped optional work still advances**, because a phase is *entered*
 *   whether or not it has anything to do. A plugin with no `manifest.dexie`
 *   still enters `schema`; one with no dependencies still enters
 *   `dependencies`. The total stays 7 for every plugin, so the bar never
 *   jumps or stalls depending on manifest shape.
 *
 * The corollary is a rule for the instrumentation in `manager.ts`: **no
 * `advance` call may be placed inside a conditional.** That is the single edit
 * that would break the contract, and there is a regression test written
 * specifically to catch it.
 */

export type PluginActivationPhase =
  "preflight" | "dependencies" | "schema" | "runtime" | "contributions" | "hooks" | "commit"

/** Ordered. Index is the number of phases completed on entry. */
export const PLUGIN_ACTIVATION_PHASES = [
  "preflight",
  "dependencies",
  "schema",
  "runtime",
  "contributions",
  "hooks",
  "commit",
] as const satisfies readonly PluginActivationPhase[]

export const PLUGIN_ACTIVATION_TOTAL = PLUGIN_ACTIVATION_PHASES.length

/** Phases completed once `phase` has been entered: `preflight` → 0 … `commit` → 6. */
export function processedForPhase(phase: PluginActivationPhase): number {
  const index = PLUGIN_ACTIVATION_PHASES.indexOf(phase)
  return index < 0 ? 0 : index
}

export type PluginActivationStatus = "running" | "completed" | "failed" | "cancelled"

export interface PluginActivationProgress {
  pluginId: string
  phase: PluginActivationPhase
  processed: number
  total: typeof PLUGIN_ACTIVATION_TOTAL
  status: PluginActivationStatus
  /** Why the activation started — mirrors `enablePlugin`'s `reason`. */
  reason?: string
  /** Set on a dependency activation, naming the plugin that required it. */
  parentPluginId?: string
  startedAt?: number
  updatedAt?: number
  errorMessage?: string
}
