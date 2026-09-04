import {
  CATEGORY_INFO,
  TABLE_TO_CATEGORY,
  categoryForTable,
  defaultDisplayName,
} from "./category-info"
import type { StorageCategory } from "./types"

describe("CATEGORY_INFO", () => {
  it("contains every storage category key", () => {
    const expected: StorageCategory[] = [
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
      "artifact",
      "vector",
      "pet",
      "system",
      "other",
    ]
    // A subset check would pass on a category that has no descriptor at all,
    // which is how `artifact` and `vector` stayed unlisted. Compare both ways.
    expect(Object.keys(CATEGORY_INFO).sort()).toEqual([...expected].sort())
    for (const k of expected) {
      expect(CATEGORY_INFO[k]).toBeDefined()
      expect(CATEGORY_INFO[k].i18nKey).toEqual(k)
      expect(typeof CATEGORY_INFO[k].defaultName).toBe("string")
      expect(Array.isArray(CATEGORY_INFO[k].tables)).toBe(true)
    }
  })

  it("each table only appears in one category", () => {
    const seen = new Set<string>()
    for (const desc of Object.values(CATEGORY_INFO)) {
      for (const t of desc.tables) {
        expect(seen.has(t)).toBe(false)
        seen.add(t)
      }
    }
  })
})

describe("TABLE_TO_CATEGORY", () => {
  it("reverses the table mapping", () => {
    expect(TABLE_TO_CATEGORY.sessions).toBe("session")
    expect(TABLE_TO_CATEGORY.messages).toBe("chat")
    expect(TABLE_TO_CATEGORY.sessionState).toBe("chat")
    expect(TABLE_TO_CATEGORY.characters).toBe("character")
    expect(TABLE_TO_CATEGORY.skills).toBe("skill")
    expect(TABLE_TO_CATEGORY.skillResources).toBe("skill")
    expect(TABLE_TO_CATEGORY.teams).toBe("team")
    expect(TABLE_TO_CATEGORY.mcpServers).toBe("mcp")
    expect(TABLE_TO_CATEGORY.promptPresets).toBe("preset")
    expect(TABLE_TO_CATEGORY.canvasDocuments).toBe("canvas")
    expect(TABLE_TO_CATEGORY.canvasVersions).toBe("canvas")
    expect(TABLE_TO_CATEGORY.canvasComments).toBe("canvas")
    expect(TABLE_TO_CATEGORY.canvasSessions).toBe("canvas")
    expect(TABLE_TO_CATEGORY.trustedWorkspaces).toBe("trustedWorkspace")
    expect(TABLE_TO_CATEGORY.tts_provider_keys).toBe("ttsKey")
    expect(TABLE_TO_CATEGORY.backupHistory).toBe("backupHistory")
    expect(TABLE_TO_CATEGORY.settings).toBe("settings")
  })
})

describe("categoryForTable", () => {
  it("returns the correct category for a known table", () => {
    expect(categoryForTable("sessions")).toBe("session")
    expect(categoryForTable("characters")).toBe("character")
  })
  it("falls back to 'other' for unknown tables", () => {
    expect(categoryForTable("not-real-table")).toBe("other")
  })
})

describe("defaultDisplayName", () => {
  it("looks up the human-readable name for each category", () => {
    expect(defaultDisplayName("settings")).toBe("Settings")
    expect(defaultDisplayName("session")).toBe("Sessions")
    expect(defaultDisplayName("chat")).toBe("Messages")
    expect(defaultDisplayName("other")).toBe("Other")
  })
})
