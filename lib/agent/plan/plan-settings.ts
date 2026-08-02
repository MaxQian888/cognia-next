/**
 * User-level plan defaults (Settings → Agent runtime → Plan mode) resolved into
 * a `Partial<PlanConfig>` the plan runtime can merge over
 * `DEFAULT_PLAN_CONFIG`. (ADR-0045)
 *
 * Every plan producer — the `ExitPlanMode` capture, the `/plan` command family
 * (planner decomposition, manual authoring, goal / team projection) — must
 * honour the same two knobs, so the read lives here instead of being re-inlined
 * per producer and drifting.
 *
 * Best-effort by contract: an unreadable settings row yields `undefined` and
 * the caller falls back to `DEFAULT_PLAN_CONFIG`. Creating a plan must never
 * fail because settings could not be loaded.
 */

import type { PlanConfig } from "@/types/agent/plan"

/**
 * Read `AppSettings.planSettings` and project the plan-config-shaped fields.
 * Returns `undefined` when nothing is configured (so callers can spread it
 * conditionally without writing an empty `config` object).
 */
export async function loadPlanConfigDefaults(): Promise<Partial<PlanConfig> | undefined> {
  try {
    const { getSettings } = await import("@/lib/db/settings")
    const s = (await getSettings())?.planSettings
    if (!s) return undefined
    if (s.requireApproval === undefined && s.maxAutoRefinements === undefined) return undefined
    return {
      ...(s.requireApproval !== undefined ? { requireApproval: s.requireApproval } : {}),
      ...(s.maxAutoRefinements !== undefined ? { maxAutoRefinements: s.maxAutoRefinements } : {}),
    }
  } catch {
    // Settings unreadable — defaults apply.
    return undefined
  }
}
