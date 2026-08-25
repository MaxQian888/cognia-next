/**
 * Token budget + degradation ladder for the skills block of a system prompt.
 *
 * The skills block grows with the user's library and nothing bounded it: both
 * `renderSkillsSection` (full bodies) and `renderSkillsCatalog` (one line per
 * skill) emitted everything they were given, and the one caller that tried to
 * pass a budget — `buildProgressiveSkillsPrompt(skills, 1024)` — had its
 * argument dropped on the floor behind an underscore.
 *
 * Degradation here is NAMED, not silent. A caller that shrinks the block gets
 * a level back and can say so; a block that shrank without anyone noticing is
 * indistinguishable from a skill the user forgot to enable.
 *
 * Two ladders, because the two blocks fail differently:
 *
 *   - a CATALOG line is `id — name: description`. The description is the
 *     droppable part, so it degrades gradually before any skill is lost.
 *   - a BODY is an instruction. Truncating one mid-sentence produces
 *     confident, wrong guidance, which is worse than the skill being absent —
 *     so bodies are only ever kept whole or omitted whole.
 *
 * Pure: no I/O, no Dexie. Token costs come from `estimateCJKTokenCount`, the
 * same estimator `lib/claude/build-options.ts` already budgets prompts with.
 */

import { estimateCJKTokenCount } from "@cognia/rag/cjk-tokenizer"

/**
 * How far the block had to degrade, worst level reached.
 *
 * Ordered: each level is strictly more lossy than the one before it.
 */
export const SKILL_PROMPT_LEVELS = [
  "under-budget",
  "shortened-descriptions",
  "dropped-descriptions",
  "omitted-skills",
] as const

export type SkillPromptLevel = (typeof SKILL_PROMPT_LEVELS)[number]

/**
 * Default ceiling for the name-only catalog, in tokens.
 *
 * 4,000 is ~2% of a 200k context — the share a discovery index can justify
 * before it starts costing more than the skills it advertises. Callers that
 * know the live model's context window should compute their own share and
 * pass it; this is the floor-of-last-resort for callers that do not.
 */
export const DEFAULT_SKILL_CATALOG_TOKEN_BUDGET = 4_000

/** Characters a description is shortened to at the `shortened-descriptions` level. */
export const SHORTENED_DESCRIPTION_CHARS = 80

export interface SkillPromptBudget {
  /**
   * Token ceiling for the rendered block. Omit — or pass a non-finite /
   * non-positive value — to keep the historical unbounded behaviour.
   */
  maxTokens?: number
  /** Ids that must survive every level, in preference to anything else. */
  protectedIds?: readonly string[]
}

export interface BudgetOutcome<T> {
  /** The entries that survived, in their original relative order. */
  kept: T[]
  /** Worst level the ladder had to reach. */
  level: SkillPromptLevel
  /** Ids omitted entirely, in the order they were dropped. */
  omitted: string[]
  /** Estimated tokens of the rendered result. */
  tokens: number
}

/** One catalog row, already split so the droppable part is addressable. */
export interface CatalogEntry {
  id: string
  /** The part that must survive if the row survives at all. */
  head: string
  /** The droppable tail (a description), without leading punctuation. */
  description?: string
}

function estimate(text: string): number {
  return text ? estimateCJKTokenCount(text) : 0
}

function budgetIsOff(budget: SkillPromptBudget | undefined): boolean {
  const max = budget?.maxTokens
  return max === undefined || !Number.isFinite(max) || max <= 0
}

/**
 * Order entries so protected ids come first — they are the last thing dropped
 * because dropping happens from the tail. Relative order is otherwise kept.
 */
function byProtectionThenOrder<T extends { id: string }>(
  entries: readonly T[],
  protectedIds: readonly string[] | undefined
): T[] {
  if (!protectedIds || protectedIds.length === 0) return [...entries]
  const isProtected = new Set(protectedIds)
  const first: T[] = []
  const rest: T[] = []
  for (const entry of entries) (isProtected.has(entry.id) ? first : rest).push(entry)
  return [...first, ...rest]
}

/** Render one catalog row at a given level. */
function renderEntry(entry: CatalogEntry, level: SkillPromptLevel): string {
  if (level === "dropped-descriptions" || !entry.description) return entry.head
  if (
    level === "shortened-descriptions" &&
    entry.description.length > SHORTENED_DESCRIPTION_CHARS
  ) {
    return `${entry.head}: ${entry.description.slice(0, SHORTENED_DESCRIPTION_CHARS).trimEnd()}…`
  }
  return `${entry.head}: ${entry.description}`
}

/**
 * Fit catalog rows into `maxTokens`, walking the ladder.
 *
 * Descriptions are shortened, then dropped, before any skill is omitted — a
 * model can still discover a skill from its name alone, but not from nothing.
 *
 * @param entries rows in display order
 * @param budget  omit or leave `maxTokens` unset to render everything
 * @param overheadTokens cost of the surrounding heading/prose the caller adds
 */
export function budgetCatalogEntries(
  entries: readonly CatalogEntry[],
  budget?: SkillPromptBudget,
  overheadTokens = 0
): BudgetOutcome<string> {
  const render = (level: SkillPromptLevel, rows: readonly CatalogEntry[]) =>
    rows.map((entry) => renderEntry(entry, level))
  const cost = (lines: readonly string[]) => overheadTokens + estimate(lines.join("\n"))

  if (budgetIsOff(budget) || entries.length === 0) {
    const kept = render("under-budget", entries)
    return { kept, level: "under-budget", omitted: [], tokens: cost(kept) }
  }
  const maxTokens = budget?.maxTokens as number

  for (const level of ["under-budget", "shortened-descriptions", "dropped-descriptions"] as const) {
    const kept = render(level, entries)
    const tokens = cost(kept)
    if (tokens <= maxTokens) return { kept, level, omitted: [], tokens }
  }

  // Still over at the leanest row shape: start omitting from the tail, keeping
  // protected ids longest.
  const ordered = byProtectionThenOrder(entries, budget?.protectedIds)
  const survivors: CatalogEntry[] = []
  const omitted: string[] = []
  let tokens = overheadTokens
  for (const entry of ordered) {
    const line = renderEntry(entry, "dropped-descriptions")
    const next = tokens + estimate(survivors.length > 0 ? `\n${line}` : line)
    if (next > maxTokens) {
      omitted.push(entry.id)
      continue
    }
    survivors.push(entry)
    tokens = next
  }
  // Re-emit in the caller's original order, not protection order.
  const keptIds = new Set(survivors.map((entry) => entry.id))
  const kept = entries
    .filter((entry) => keptIds.has(entry.id))
    .map((entry) => renderEntry(entry, "dropped-descriptions"))
  return { kept, level: "omitted-skills", omitted, tokens: cost(kept) }
}

/** One full-body skill block, kept whole or omitted whole. */
export interface BodyEntry {
  id: string
  /** The fully rendered `## Name` + body block. */
  text: string
}

/**
 * Fit full skill bodies into `maxTokens` by omitting whole skills.
 *
 * There is no partial level: a truncated instruction is worse than a missing
 * one, so the ladder is `under-budget` → `omitted-skills` and nothing between.
 */
export function budgetSkillBodies(
  entries: readonly BodyEntry[],
  budget?: SkillPromptBudget,
  overheadTokens = 0
): BudgetOutcome<string> {
  if (budgetIsOff(budget) || entries.length === 0) {
    const kept = entries.map((entry) => entry.text)
    return {
      kept,
      level: "under-budget",
      omitted: [],
      tokens: overheadTokens + estimate(kept.join("\n\n")),
    }
  }
  const maxTokens = budget?.maxTokens as number

  const whole = entries.map((entry) => entry.text)
  const wholeTokens = overheadTokens + estimate(whole.join("\n\n"))
  if (wholeTokens <= maxTokens) {
    return { kept: whole, level: "under-budget", omitted: [], tokens: wholeTokens }
  }

  const ordered = byProtectionThenOrder(entries, budget?.protectedIds)
  const survivors: BodyEntry[] = []
  const omitted: string[] = []
  let tokens = overheadTokens
  for (const entry of ordered) {
    const next = tokens + estimate(survivors.length > 0 ? `\n\n${entry.text}` : entry.text)
    if (next > maxTokens) {
      omitted.push(entry.id)
      continue
    }
    survivors.push(entry)
    tokens = next
  }
  const keptIds = new Set(survivors.map((entry) => entry.id))
  const kept = entries.filter((entry) => keptIds.has(entry.id)).map((entry) => entry.text)
  return {
    kept,
    level: "omitted-skills",
    omitted,
    tokens: overheadTokens + estimate(kept.join("\n\n")),
  }
}

/** True when the outcome lost something a reader would want to know about. */
export function didDegrade(outcome: BudgetOutcome<unknown>): boolean {
  return outcome.level !== "under-budget"
}
