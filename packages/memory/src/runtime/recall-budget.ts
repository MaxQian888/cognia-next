/**
 * How the two recall sections share a token budget.
 *
 * THE CONSTRAINT THAT DECIDES THE SHAPE: `recallTokenBudget` is a number the
 * user set themselves in Settings → Memory, and its meaning is already fixed —
 * "how much room learned memory gets". Carving the project section out of it
 * would silently shrink personal recall on upgrade for everyone who ever touched
 * that slider. Concretely, at the default 900 the procedural block takes
 * `min(600, 900 × 0.4) = 360` first, leaving personal recall ≥540; splitting it
 * 450/450 would leave ~90 tokens, roughly one memory. So the project section
 * gets its OWN budget and the combined ceiling rises rather than the personal
 * half falling.
 *
 * BORROWING IS ONE-WAY, and that is a consequence of ordering rather than a
 * policy choice: the personal section has to be packed before anyone can know
 * how much of its budget went unused, so only the project section — which packs
 * second — can be told about the leftover. Reversing it would mean packing
 * personal twice. Stated here because the asymmetry looks arbitrary from either
 * call site alone.
 *
 * Pure: no I/O, no clock.
 */

/** Most the project section may borrow from unused personal headroom. */
export const MAX_PROJECT_BORROW_TOKENS = 450

/** Hard ceiling on the project section however much headroom is going spare. */
export const PROJECT_RECALL_CEILING_TOKENS = 900

export interface ResolveProjectRecallBudgetInput {
  /** `MemoryConfig.recallTokenBudget` — what the personal section was allowed. */
  personalLimit: number
  /** What the personal section actually used (`ApplyMemoryContextResult.budget.used`). */
  personalUsed: number
  /** `MemoryConfig.projectRecallTokenBudget` — the project section's own budget. */
  projectBudget: number
}

export interface ProjectRecallBudget {
  /** Tokens the project section may spend. */
  limit: number
  /** How much of that came from unused personal headroom. */
  borrowed: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function resolveProjectRecallBudget(
  input: ResolveProjectRecallBudgetInput
): ProjectRecallBudget {
  const base = Math.max(0, input.projectBudget)
  const headroom = clamp(input.personalLimit - input.personalUsed, 0, MAX_PROJECT_BORROW_TOKENS)
  const limit = Math.min(base + headroom, PROJECT_RECALL_CEILING_TOKENS)
  return { limit, borrowed: Math.max(0, limit - base) }
}

/**
 * The most the two sections can actually cost together — for the settings copy,
 * and for the test that keeps the copy honest.
 *
 * It is `personalLimit + projectBudget`, NOT `personalLimit + maxProjectLimit`.
 * The larger figure is unreachable: borrowing is bounded by the headroom the
 * personal section left behind, so every token the project section borrows is a
 * token personal did not spend. Advertising the bigger number would promise a
 * cost the code cannot produce. `recall-budget.test.ts` searches the whole range
 * of personal spend rather than trusting this algebra.
 */
export function maxCombinedRecallTokens(personalLimit: number, projectBudget: number): number {
  return Math.max(0, personalLimit) + Math.max(0, projectBudget)
}
