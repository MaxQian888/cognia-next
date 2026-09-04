import {
  BUILTIN_SKILL_ID_PREFIX,
  BUILT_IN_SKILL_CATALOG,
  loadBuiltInSkillContent,
} from "@/lib/skills/built-in-catalog"
import { ONBOARDING_SKILL_BUNDLE_ID, onboardingSkillEntry, onboardingSkillRowId } from "./skill"
import { STARTER_CARDS } from "./starter-cards"

describe("the first-run skill exists and is live", () => {
  it("is present in the generated catalog", () => {
    expect(onboardingSkillEntry().id).toBe(ONBOARDING_SKILL_BUNDLE_ID)
  })

  it("ships enabled — a skill the user must go turn on cannot shape the first turn", () => {
    expect(onboardingSkillEntry().defaultEnabled).toBe(true)
  })

  it("auto-activates on no surface, so it only fires on the first-run prompts", () => {
    expect(onboardingSkillEntry().surface).toEqual([])
  })
})

describe("identity cannot be claimed by anything else", () => {
  // Multica keeps its equivalent skill's identity on the server so a client
  // cannot forge it. With no server, these three properties are the substitute.

  it("derives its row id rather than declaring one", () => {
    expect(onboardingSkillRowId()).toBe(`${BUILTIN_SKILL_ID_PREFIX}cognia_onboarding`)
  })

  it("sits in the reserved built-in namespace", () => {
    expect(onboardingSkillRowId().startsWith(BUILTIN_SKILL_ID_PREFIX)).toBe(true)
  })

  it("is the only catalog entry claiming that bundle id", () => {
    const matches = BUILT_IN_SKILL_CATALOG.filter((e) => e.id === ONBOARDING_SKILL_BUNDLE_ID)
    expect(matches).toHaveLength(1)
  })

  it("throws loudly if codegen ever drops it", () => {
    const spy = jest.spyOn(BUILT_IN_SKILL_CATALOG, "find").mockReturnValue(undefined as never)
    expect(() => onboardingSkillEntry()).toThrow(/pnpm skills:build/)
    spy.mockRestore()
  })
})

describe("the skill and the cards move together", () => {
  it("names every starter card's intent in its instructions", async () => {
    // The skill matches on these three prompts. If a card is added or renamed
    // without updating the script, the first run silently loses its shape.
    const content = await loadBuiltInSkillContent(onboardingSkillEntry().id)
    expect(STARTER_CARDS).toHaveLength(3)
    expect(content).toMatch(/Read a folder/i)
    expect(content).toMatch(/Extract text from a screenshot/i)
    expect(content).toMatch(/Summarize a web page/i)
  })

  it("forbids the speculative objects a first run cannot justify", async () => {
    const content = await loadBuiltInSkillContent(onboardingSkillEntry().id)
    expect(content).toMatch(/Create nothing else/i)
  })

  it("forbids re-greeting — the user already asked by picking a card", async () => {
    expect(await loadBuiltInSkillContent(onboardingSkillEntry().id)).toMatch(
      /not being introduced/i
    )
  })
})
