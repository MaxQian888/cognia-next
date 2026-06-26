/**
 * @jest-environment jsdom
 */

import type { Skill } from "@/lib/claude/types"

// useLiveQuery is mocked to INVOKE its querier (so the ids-gating ternary runs)
// then return whatever rows the test stages — `undefined` simulates the initial
// loading frame. The pure resolver (resolveEffectiveSkills) stays real so
// precedence is exercised.
const rowsRef: { current: Skill[] | undefined } = { current: [] }
const listSkillsByIdsMock = jest.fn(async () => rowsRef.current ?? [])
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (fn: () => unknown) => {
    void fn()
    return rowsRef.current
  },
}))
jest.mock("@/lib/db/skills", () => ({
  ...jest.requireActual("@/lib/db/skills"),
  listSkillsByIds: (...a: unknown[]) => listSkillsByIdsMock(...(a as [])),
}))

import { renderHook } from "@testing-library/react"
import { useEffectiveSkills } from "./use-effective-skills"

const mkSkill = (id: string, name = id): Skill =>
  ({ id, name, content: "x", createdAt: 0, updatedAt: 0, source: "custom" }) as Skill

beforeEach(() => {
  rowsRef.current = []
  listSkillsByIdsMock.mockClear()
})

describe("useEffectiveSkills", () => {
  it("hydrates + tags character and ephemeral entries", () => {
    rowsRef.current = [mkSkill("a", "Alpha"), mkSkill("c", "Cee")]
    const { result } = renderHook(() =>
      useEffectiveSkills({ characterSkillIds: ["a"], ephemeralSkillIds: ["c"] })
    )
    expect(result.current.items.map((i) => [i.id, i.source])).toEqual([
      ["a", "character"],
      ["c", "ephemeral"],
    ])
    expect(result.current.activeCount).toBe(2)
    expect(result.current.totalCount).toBe(2)
  })

  it("marks disabled ids inert and excludes them from activeCount", () => {
    rowsRef.current = [mkSkill("a"), mkSkill("c")]
    const { result } = renderHook(() =>
      useEffectiveSkills({
        characterSkillIds: ["a"],
        ephemeralSkillIds: ["c"],
        disabledIds: ["c"],
      })
    )
    expect(result.current.items.find((i) => i.id === "c")?.inert).toBe(true)
    expect(result.current.activeCount).toBe(1)
    expect(result.current.totalCount).toBe(2)
  })

  it("drops stale ids whose row no longer exists", () => {
    rowsRef.current = [mkSkill("a")] // "gone" has no row
    const { result } = renderHook(() => useEffectiveSkills({ ephemeralSkillIds: ["a", "gone"] }))
    expect(result.current.items.map((i) => i.id)).toEqual(["a"])
  })

  it("queries Dexie only when there are ids to resolve", () => {
    renderHook(() => useEffectiveSkills({ ephemeralSkillIds: ["a"] }))
    expect(listSkillsByIdsMock).toHaveBeenCalledWith(["a"])
    listSkillsByIdsMock.mockClear()
    renderHook(() => useEffectiveSkills({}))
    expect(listSkillsByIdsMock).not.toHaveBeenCalled()
  })

  it("yields an empty view on the initial loading frame (rows undefined)", () => {
    rowsRef.current = undefined
    const { result } = renderHook(() => useEffectiveSkills({ characterSkillIds: ["a"] }))
    expect(result.current.items).toEqual([])
    expect(result.current.activeCount).toBe(0)
  })
})
