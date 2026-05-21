import { groupPresets } from "./group-presets"
import type { SystemPromptPreset } from "@/lib/claude/types"

function preset(overrides: Partial<SystemPromptPreset>): SystemPromptPreset {
  return {
    id: overrides.id ?? "x",
    name: overrides.name ?? "X",
    content: overrides.content ?? "...",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as unknown as SystemPromptPreset
}

describe("groupPresets", () => {
  it("returns an empty array for empty input", () => {
    expect(groupPresets([])).toEqual([])
  })

  it("groups favorites first", () => {
    const groups = groupPresets([
      preset({ id: "a", isFavorite: true }),
      preset({ id: "b", category: "coding" }),
    ])
    expect(groups[0].label).toBe("favorites")
    expect(groups[0].translateLabel).toBe(true)
    expect(groups[0].presets.map((p) => p.id)).toEqual(["a"])
  })

  it("emits a default group after favorites for defaults not already in favorites", () => {
    const groups = groupPresets([
      preset({ id: "fav", isFavorite: true }),
      preset({ id: "def", isDefault: true }),
    ])
    expect(groups.map((g) => g.label)).toEqual(["favorites", "default"])
    expect(groups[1].presets.map((p) => p.id)).toEqual(["def"])
  })

  it("does not duplicate a default preset that is already in favorites", () => {
    const groups = groupPresets([preset({ id: "both", isFavorite: true, isDefault: true })])
    const labels = groups.map((g) => g.label)
    expect(labels).toContain("favorites")
    expect(labels).not.toContain("default")
  })

  it("groups remaining presets by category", () => {
    const groups = groupPresets([
      preset({ id: "c1", category: "coding" }),
      preset({ id: "c2", category: "coding" }),
      preset({ id: "w1", category: "writing" }),
    ])
    const codingGroup = groups.find((g) => g.label === "coding")
    expect(codingGroup?.presets.map((p) => p.id)).toEqual(["c1", "c2"])
    const writingGroup = groups.find((g) => g.label === "writing")
    expect(writingGroup?.presets.map((p) => p.id)).toEqual(["w1"])
  })

  it("collects uncategorized leftovers into an 'other' group", () => {
    const groups = groupPresets([preset({ id: "loose" })])
    const other = groups.find((g) => g.label === "other")
    expect(other).toBeDefined()
    expect(other?.translateLabel).toBe(true)
    expect(other?.presets.map((p) => p.id)).toEqual(["loose"])
  })
})
