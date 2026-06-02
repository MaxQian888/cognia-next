import { render } from "@testing-library/react"

jest.mock("dexie-react-hooks", () => ({ useLiveQuery: jest.fn() }))
import { useLiveQuery } from "dexie-react-hooks"
import { AchievementsTab } from "./achievements-tab"
import { PET_ACHIEVEMENTS } from "@/lib/pet/achievements/registry"

const liveQuery = useLiveQuery as jest.Mock

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
})
