/**
 * @jest-environment jsdom
 */

import type { Skill } from "@cognia/agent-config-types"

const rowsRef: { current: Skill[] | undefined } = { current: [] }
const listSkillsMock = jest.fn(async () => rowsRef.current ?? [])
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (fn: () => unknown) => {
    void fn()
    return rowsRef.current
  },
}))
jest.mock("@/lib/db/skills", () => ({
  ...jest.requireActual("@/lib/db/skills"),
  listSkills: () => listSkillsMock(),
}))

import { renderHook } from "@testing-library/react"
import { useMentionableSkills } from "./use-mentionable-skills"

const mkSkill = (id: string, name: string, over: Partial<Skill> = {}): Skill =>
  ({ id, name, content: "x", createdAt: 0, updatedAt: 0, source: "custom", ...over }) as Skill

beforeEach(() => {
  rowsRef.current = []
  listSkillsMock.mockClear()
})

describe("useMentionableSkills", () => {
  it("projects enabled skills into mention targets", () => {
    rowsRef.current = [mkSkill("a", "Alpha", { description: "first" }), mkSkill("b", "Beta")]
    const { result } = renderHook(() => useMentionableSkills())
    expect(result.current).toEqual([
      { id: "a", name: "Alpha", description: "first" },
      { id: "b", name: "Beta", description: undefined },
    ])
  })

  it("omits disabled skills (enabling them would be a no-op)", () => {
    rowsRef.current = [
      mkSkill("a", "Alpha", { status: "enabled" }),
      mkSkill("b", "Beta", { status: "disabled" }),
    ]
    const { result } = renderHook(() => useMentionableSkills())
    expect(result.current.map((s) => s.id)).toEqual(["a"])
  })

  it("returns an empty list while the query is loading (undefined)", () => {
    rowsRef.current = undefined
    const { result } = renderHook(() => useMentionableSkills())
    expect(result.current).toEqual([])
  })

  it("treats a row with no status as enabled (back-compat)", () => {
    rowsRef.current = [mkSkill("a", "Alpha")]
    const { result } = renderHook(() => useMentionableSkills())
    expect(result.current.map((s) => s.id)).toEqual(["a"])
  })

  it("does not query Dexie when disabled", () => {
    rowsRef.current = []
    renderHook(() => useMentionableSkills(false))
    // The querier's disabled branch returns Promise.resolve([]) — listSkills is
    // never invoked.
    expect(listSkillsMock).not.toHaveBeenCalled()
  })
})
