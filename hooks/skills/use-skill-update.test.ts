/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

const listSkillsMock = jest.fn()
const checkUpdatesMock = jest.fn()
const itemFromSkillMock = jest.fn()
const installMock = jest.fn()

jest.mock("@/lib/db/skills", () => ({
  listSkills: () => listSkillsMock(),
}))
jest.mock("@/lib/skills/skillssh-updates", () => ({
  checkSkillsShUpdates: (skills: unknown) => checkUpdatesMock(skills),
  marketplaceItemFromSkill: (skill: unknown) => itemFromSkillMock(skill),
}))
jest.mock("@/lib/skills/marketplace-install", () => ({
  installMarketplaceItem: (item: unknown) => installMock(item),
}))

import type { Skill } from "@cognia/agent-config-types"
import { useSkillUpdate } from "./use-skill-update"

const SKILL = { id: "s1", name: "find-skills", content: "x" } as Skill

beforeEach(() => {
  listSkillsMock.mockReset().mockResolvedValue([SKILL])
  checkUpdatesMock.mockReset().mockResolvedValue([])
  itemFromSkillMock.mockReset().mockReturnValue({ id: "skillssh:o/r/s" })
  installMock.mockReset().mockResolvedValue({ skill: SKILL, created: false })
})

describe("useSkillUpdate", () => {
  it("checkAll records statuses and returns the update count", async () => {
    checkUpdatesMock.mockResolvedValue([
      { skillId: "s1", canonicalId: "skillssh:o/r/a", hasUpdate: true, remoteHash: "h2" },
      { skillId: "s2", canonicalId: "skillssh:o/r/b", hasUpdate: false },
    ])
    const { result } = renderHook(() => useSkillUpdate())
    let count = 0
    await act(async () => {
      count = await result.current.checkAll()
    })
    expect(count).toBe(1)
    expect(result.current.hasUpdate("s1")).toBe(true)
    expect(result.current.hasUpdate("s2")).toBe(false)
    expect(result.current.statuses.s1.remoteHash).toBe("h2")
  })

  it("checking flag toggles around checkAll", async () => {
    let release: () => void = () => undefined
    checkUpdatesMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve([])
        })
    )
    const { result } = renderHook(() => useSkillUpdate())
    let p!: Promise<number>
    act(() => {
      p = result.current.checkAll()
    })
    await waitFor(() => expect(result.current.checking).toBe(true))
    await act(async () => {
      release()
      await p
    })
    expect(result.current.checking).toBe(false)
  })

  it("updateOne re-installs and clears the skill's update flag", async () => {
    checkUpdatesMock.mockResolvedValue([
      { skillId: "s1", canonicalId: "skillssh:o/r/s", hasUpdate: true, remoteHash: "h2" },
    ])
    const { result } = renderHook(() => useSkillUpdate())
    await act(async () => {
      await result.current.checkAll()
    })
    await act(async () => {
      await result.current.updateOne(SKILL)
    })
    expect(installMock).toHaveBeenCalledWith({ id: "skillssh:o/r/s" })
    expect(result.current.hasUpdate("s1")).toBe(false)
    expect(result.current.statuses.s1.currentHash).toBe("h2")
  })

  it("updateOne throws on non-marketplace skills", async () => {
    itemFromSkillMock.mockReturnValue(null)
    const { result } = renderHook(() => useSkillUpdate())
    await expect(result.current.updateOne(SKILL)).rejects.toThrow(/not installed from skills\.sh/)
    expect(installMock).not.toHaveBeenCalled()
  })

  it("updatingId tracks the in-flight update", async () => {
    let release: () => void = () => undefined
    installMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(undefined)
        })
    )
    const { result } = renderHook(() => useSkillUpdate())
    let p!: Promise<void>
    act(() => {
      p = result.current.updateOne(SKILL)
    })
    await waitFor(() => expect(result.current.updatingId).toBe("s1"))
    await act(async () => {
      release()
      await p
    })
    expect(result.current.updatingId).toBeNull()
  })
})
