import {
  CATEGORY_COLORS,
  CATEGORY_ICONS,
  categoryColor,
  categoryIcon,
} from "./storage-category-visuals"
import type { StorageCategory } from "@/lib/storage"

// Every category the storage manager can report, spelled out so a new
// `StorageCategory` member fails here instead of rendering an undefined icon.
const ALL_CATEGORIES: StorageCategory[] = [
  "settings",
  "session",
  "chat",
  "character",
  "skill",
  "team",
  "mcp",
  "preset",
  "canvas",
  "trustedWorkspace",
  "ttsKey",
  "backupHistory",
  "vector",
  "artifact",
  "pet",
  "system",
  "other",
]

describe("storage-category-visuals", () => {
  it("covers every storage category with an icon and a fill colour", () => {
    for (const category of ALL_CATEGORIES) {
      expect(CATEGORY_ICONS[category]).toBeDefined()
      expect(CATEGORY_COLORS[category]).toMatch(/^bg-/)
    }
    expect(Object.keys(CATEGORY_ICONS).sort()).toEqual([...ALL_CATEGORIES].sort())
    expect(Object.keys(CATEGORY_COLORS).sort()).toEqual([...ALL_CATEGORIES].sort())
  })

  it("falls back to the 'other' visuals for an unknown category", () => {
    const unknown = "nope" as StorageCategory
    expect(categoryIcon(unknown)).toBe(CATEGORY_ICONS.other)
    expect(categoryColor(unknown)).toBe(CATEGORY_COLORS.other)
  })
})
