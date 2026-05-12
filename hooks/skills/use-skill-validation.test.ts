/**
 * @jest-environment jsdom
 */
import { renderHook, waitFor } from "@testing-library/react"

const skillRowRef: { current: import("@/lib/claude/types").Skill | undefined } = {
  current: undefined,
}
const resourcesRef: { current: import("@/lib/claude/types").SkillResource[] } = {
  current: [],
}
const updateSkillMock = jest.fn()

// Mock useLiveQuery: hook calls it twice per render — first for the skill,
// then for the resources. Track the per-render call index via a renderCounter
// that resets at the start of every render via a small wrapper.
let liveQueryCallIdx = 0
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => {
    const idx = liveQueryCallIdx++
    if (idx % 2 === 0) return skillRowRef.current
    return resourcesRef.current
  },
}))

jest.mock("@/lib/db/skills", () => ({
  getSkill: async (id: string) =>
    skillRowRef.current?.id === id ? skillRowRef.current : undefined,
  updateSkill: (...args: unknown[]) => updateSkillMock(...args),
}))
jest.mock("@/lib/db/skill-resources", () => ({
  listResourcesForSkill: async () => resourcesRef.current,
}))

import { useSkillValidation } from "./use-skill-validation"
import type { Skill, SkillResource } from "@/lib/claude/types"

beforeEach(() => {
  skillRowRef.current = undefined
  resourcesRef.current = []
  updateSkillMock.mockReset()
  liveQueryCallIdx = 0
})

function makeSkill(over: Partial<Skill>): Skill {
  return {
    id: "s1",
    name: "Valid Name",
    content: "body",
    createdAt: 0,
    updatedAt: 0,
    source: "custom",
    ...over,
  } as Skill
}

describe("useSkillValidation", () => {
  it("does nothing when skillId is undefined", async () => {
    renderHook(() => useSkillValidation(undefined))
    await new Promise((r) => setTimeout(r, 20))
    expect(updateSkillMock).not.toHaveBeenCalled()
  })

  it("writes validationErrors when name is empty (live)", async () => {
    skillRowRef.current = makeSkill({ name: "" })
    renderHook(() => useSkillValidation("s1"))
    await waitFor(() => expect(updateSkillMock).toHaveBeenCalled())
    const [id, patch] = updateSkillMock.mock.calls[0]
    expect(id).toBe("s1")
    expect(patch.validationErrors.some((e: { code: string }) => e.code === "missing-name")).toBe(
      true
    )
  })

  it("does NOT re-write when computed errors equal persisted errors", async () => {
    skillRowRef.current = makeSkill({
      validationErrors: [{ code: "missing-name", field: "name", message: "Name is required." }],
      name: "",
    })
    renderHook(() => useSkillValidation("s1"))
    await new Promise((r) => setTimeout(r, 20))
    expect(updateSkillMock).not.toHaveBeenCalled()
  })

  it("does NOT re-fire after writing the same error key (loop guard)", async () => {
    skillRowRef.current = makeSkill({ name: "" })
    const { rerender } = renderHook(() => useSkillValidation("s1"))
    await waitFor(() => expect(updateSkillMock).toHaveBeenCalledTimes(1))
    // Simulate Dexie liveQuery firing again with the same row state.
    rerender()
    await new Promise((r) => setTimeout(r, 20))
    expect(updateSkillMock).toHaveBeenCalledTimes(1)
  })

  it("re-validates when resources change", async () => {
    skillRowRef.current = makeSkill({})
    resourcesRef.current = [
      {
        id: "r1",
        skillId: "s1",
        kind: "script",
        name: "x",
        path: "x.sh",
        content: "echo",
        encoding: "utf-8",
        size: 0,
        createdAt: 0,
        updatedAt: 0,
      } as SkillResource,
    ]
    renderHook(() => useSkillValidation("s1"))
    // Resources don't trigger any current validation rules — but we should not
    // throw and not write if errors match.
    await new Promise((r) => setTimeout(r, 20))
    expect(updateSkillMock).not.toHaveBeenCalled()
  })
})
