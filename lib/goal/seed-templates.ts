/**
 * Built-in goal templates (ADR-0019 Phase 2). Seeded on access so a fresh
 * install has useful presets without the user authoring any. Idempotent: the
 * seed only inserts a built-in id that doesn't already exist, so user edits
 * to a cloned copy (a different id) are never clobbered, and re-running is a
 * no-op. Mirrors the character/skill seed-on-access pattern in `lib/db/seed.ts`.
 */

import type { GoalTemplate } from "@/types/goal"
import { getDb } from "@/lib/db/schema"

/** Stable built-in id prefix — `seedGoalTemplates` keys idempotency on these. */
export const BUILTIN_GOAL_TEMPLATE_PREFIX = "gtpl_builtin_"

type BuiltinSeed = Pick<GoalTemplate, "id" | "title" | "objectiveText"> & {
  configOverrides?: GoalTemplate["configOverrides"]
}

/**
 * The shipped presets. `configOverrides` only sets knobs that differ from the
 * resolved defaults — e.g. a PR review wants more turns; a quick summary wants
 * fewer. Objective text is intentionally generic so the user tailors it after
 * one-click creation.
 */
export const BUILTIN_GOAL_TEMPLATES: readonly BuiltinSeed[] = [
  {
    id: `${BUILTIN_GOAL_TEMPLATE_PREFIX}review_pr`,
    title: "Review this PR",
    objectiveText:
      "Review the pull request currently in context: summarize the change, flag correctness/security issues, and leave concrete suggestions. Stop when the review is complete.",
    configOverrides: { maxTurns: 30 },
  },
  {
    id: `${BUILTIN_GOAL_TEMPLATE_PREFIX}summarise_week`,
    title: "Summarise my week",
    objectiveText:
      "Produce a concise summary of what I worked on this week and the open threads I should pick up next. Stop once the summary is delivered.",
    configOverrides: { maxTurns: 8 },
  },
  {
    id: `${BUILTIN_GOAL_TEMPLATE_PREFIX}draft_changelog`,
    title: "Draft a release changelog",
    objectiveText:
      "Draft a release changelog grouped by Added / Changed / Fixed from the recent commits in context. Stop when the changelog is ready for review.",
  },
  {
    id: `${BUILTIN_GOAL_TEMPLATE_PREFIX}triage_inbox`,
    title: "Triage my inbox",
    objectiveText:
      "Triage the items in context: classify by urgency, draft suggested replies for the ones that need them, and list what requires my decision. Stop when triage is complete.",
    configOverrides: { maxTurns: 15 },
  },
]

/**
 * Insert any missing built-in templates. Idempotent — existing ids (built-in
 * or user) are left untouched. New built-ins get an ascending `sortOrder`
 * matching their declaration order so the picker is stable.
 */
export async function seedGoalTemplates(): Promise<void> {
  const table = getDb().goalTemplates
  const now = Date.now()
  await Promise.all(
    BUILTIN_GOAL_TEMPLATES.map(async (seed, index) => {
      const existing = await table.get(seed.id)
      if (existing) return
      const row: GoalTemplate = {
        id: seed.id,
        title: seed.title,
        objectiveText: seed.objectiveText,
        configOverrides: seed.configOverrides,
        builtin: true,
        isFavorite: false,
        sortOrder: index,
        createdAt: now,
        updatedAt: now,
      }
      await table.put(row)
    })
  )
}
