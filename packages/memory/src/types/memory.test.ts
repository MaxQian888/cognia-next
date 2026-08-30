import {
  PROJECT_MEMORY_KINDS,
  isMemorySourceChannel,
  isProjectClaim,
  isProjectMemoryKind,
  type Memory,
} from "./memory"

describe("isProjectMemoryKind", () => {
  it.each([...PROJECT_MEMORY_KINDS])("accepts %s", (kind) => {
    expect(isProjectMemoryKind(kind)).toBe(true)
  })

  it.each([undefined, null, "", "semantic", "project", 3, {}])("rejects %p", (value) => {
    expect(isProjectMemoryKind(value)).toBe(false)
  })

  it("does not overlap the memory-type or source-channel vocabularies", () => {
    // The kinds live on a different axis than `MemoryType`; an accidental
    // collision would make a mis-typed value validate against the wrong guard.
    for (const kind of PROJECT_MEMORY_KINDS) {
      expect(isMemorySourceChannel(kind)).toBe(false)
    }
  })
})

describe("isProjectClaim", () => {
  it("treats an absent projectMemoryKind as personal", () => {
    // Every row written before project mining existed has no kind, and must keep
    // behaving exactly as it does today. This is the migration contract.
    expect(isProjectClaim({ projectMemoryKind: undefined })).toBe(false)
    expect(isProjectClaim({} as Pick<Memory, "projectMemoryKind">)).toBe(false)
  })

  it.each([...PROJECT_MEMORY_KINDS])("treats %s as a project claim", (kind) => {
    expect(isProjectClaim({ projectMemoryKind: kind })).toBe(true)
  })
})
