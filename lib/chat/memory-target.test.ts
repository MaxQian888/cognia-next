import {
  COMPOSER_MEMORY_TARGETS,
  isMemoryTargetAvailable,
  memoryTargetKey,
  parseMemoryTargetKey,
  type ComposerMemoryTarget,
} from "./memory-target"

describe("COMPOSER_MEMORY_TARGETS", () => {
  it("offers the two store scopes before the two file scopes", () => {
    expect(COMPOSER_MEMORY_TARGETS.map(memoryTargetKey)).toEqual([
      "store:global",
      "store:workspace",
      "file:project",
      "file:user",
    ])
  })

  it("does not offer the context-derived store scopes", () => {
    const scopes = COMPOSER_MEMORY_TARGETS.map((t) => t.scope)
    expect(scopes).not.toContain("character")
    expect(scopes).not.toContain("agent")
  })
})

describe("memoryTargetKey / parseMemoryTargetKey", () => {
  it("round-trips every offered target", () => {
    for (const target of COMPOSER_MEMORY_TARGETS) {
      expect(parseMemoryTargetKey(memoryTargetKey(target))).toEqual(target)
    }
  })

  it("returns null for unknown, empty or nullish keys", () => {
    expect(parseMemoryTargetKey("store:character")).toBeNull()
    expect(parseMemoryTargetKey("file:global")).toBeNull()
    expect(parseMemoryTargetKey("nonsense")).toBeNull()
    expect(parseMemoryTargetKey("")).toBeNull()
    expect(parseMemoryTargetKey(null)).toBeNull()
    expect(parseMemoryTargetKey(undefined)).toBeNull()
  })
})

describe("isMemoryTargetAvailable", () => {
  const file: ComposerMemoryTarget = { target: "file", scope: "project" }
  const store: ComposerMemoryTarget = { target: "store", scope: "global" }

  it("allows store writes on every platform", () => {
    expect(isMemoryTargetAvailable(store, true)).toBe(true)
    expect(isMemoryTargetAvailable(store, false)).toBe(true)
  })

  it("restricts file writes to the desktop shell", () => {
    expect(isMemoryTargetAvailable(file, true)).toBe(true)
    expect(isMemoryTargetAvailable(file, false)).toBe(false)
  })
})
