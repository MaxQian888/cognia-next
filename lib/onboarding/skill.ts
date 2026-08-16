import { BUILT_IN_SKILL_CATALOG, builtinSkillId } from "@/lib/skills/built-in-catalog"
import type { BuiltInSkillCatalogEntry } from "@/lib/skills/built-in-catalog"

/**
 * Bundle id of the built-in skill that shapes the first conversation
 * (ADR-0122, decision 9). Matches the folder name under `skills/built-in/`.
 */
export const ONBOARDING_SKILL_BUNDLE_ID = "cognia-onboarding"

/**
 * The Dexie row id the bundle seeds to, e.g. `skill_builtin_cognia_onboarding`.
 *
 * **Why this matters here rather than being an implementation detail.** Multica
 * keeps its equivalent skill's identity on the server, so a client cannot mint
 * an agent that claims it. Cognia has no server, so the substitute is
 * structural: the id is *derived* from the catalog rather than declared, and it
 * lives in the reserved `skill_builtin_` namespace that only the codegen'd
 * catalog seeds into. A plugin-contributed skill goes through the in-memory
 * plugin registry with its own id and never reaches this row; and boot-time
 * seeding re-asserts the catalog's content over whatever a row currently holds,
 * so a direct write does not survive a restart.
 *
 * `lib/onboarding/skill.test.ts` pins all three of those properties. They are
 * the only thing standing between "the product wrote the first-run script" and
 * "something else did".
 */
export function onboardingSkillRowId(): string {
  return builtinSkillId(onboardingSkillEntry())
}

/** The catalog entry. Throws rather than returning undefined: the flow's
 *  terminal step depends on this skill existing, and a silent absence would
 *  show up as a first conversation that quietly behaves like any other. */
export function onboardingSkillEntry(): BuiltInSkillCatalogEntry {
  const entry = BUILT_IN_SKILL_CATALOG.find((e) => e.id === ONBOARDING_SKILL_BUNDLE_ID)
  if (!entry) {
    throw new Error(
      `Built-in skill "${ONBOARDING_SKILL_BUNDLE_ID}" is missing from the catalog — run \`pnpm skills:build\``
    )
  }
  return entry
}
