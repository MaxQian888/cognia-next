import { render } from "@testing-library/react"

jest.mock("dexie-react-hooks", () => ({ useLiveQuery: jest.fn() }))
import { useLiveQuery } from "dexie-react-hooks"
import { AchievementsTab } from "./achievements-tab"
import { PET_ACHIEVEMENTS } from "@/lib/pet/achievements/registry"
import {
  registerPetAchievement,
  __resetPetAchievementsForTesting,
} from "@/lib/plugin/registries/pet-achievement-registry"

const liveQuery = useLiveQuery as jest.Mock

afterEach(() => {
  __resetPetAchievementsForTesting()
})

describe("AchievementsTab", () => {
  it("renders all achievements with unlocked state from Dexie", () => {
    liveQuery.mockReturnValue([{ id: "hatched", unlockedAt: 1 }])
    const { container } = render(<AchievementsTab />)
    expect(container.querySelectorAll("[data-achievement]")).toHaveLength(PET_ACHIEVEMENTS.length)
    expect(container.querySelector('[data-achievement="hatched"]')).toHaveAttribute(
      "data-unlocked",
      "true"
    )
    expect(container.querySelector('[data-achievement="legendary"]')).toHaveAttribute(
      "data-unlocked",
      "false"
    )
  })

  it("treats an undefined query result as nothing unlocked", () => {
    liveQuery.mockReturnValue(undefined)
    const { container } = render(<AchievementsTab />)
    expect(container.querySelector('[data-achievement="hatched"]')).toHaveAttribute(
      "data-unlocked",
      "false"
    )
  })

  it("renders plugin achievements with plain labels and their unlock state", () => {
    registerPetAchievement(
      "quest-streak",
      {
        id: "quest-streak",
        labels: { en: "Quest Streak" },
        descriptions: { en: "Complete quests 7 days in a row." },
        condition: { type: "level", gte: 1 },
      },
      { pluginId: "p1" }
    )
    liveQuery.mockReturnValue([{ id: "plugin:p1:quest-streak", unlockedAt: 1 }])
    const { container } = render(<AchievementsTab />)
    const card = container.querySelector('[data-achievement="plugin:p1:quest-streak"]')
    expect(card).not.toBeNull()
    expect(card).toHaveAttribute("data-unlocked", "true")
    expect(card!.textContent).toContain("Quest Streak")
    expect(card!.textContent).toContain("Complete quests 7 days in a row.")
    // Static entries still render alongside.
    expect(container.querySelectorAll("[data-achievement]")).toHaveLength(
      PET_ACHIEVEMENTS.length + 1
    )
  })
})
