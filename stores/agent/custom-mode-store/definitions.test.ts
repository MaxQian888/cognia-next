/**
 * @jest-environment jsdom
 */
import {
  TOOL_CATEGORIES,
  ALL_AVAILABLE_TOOLS,
  TOOL_REQUIREMENTS,
  checkToolAvailability,
  MODE_TEMPLATES,
  getModeTemplate,
  AVAILABLE_MODE_ICONS,
} from "./definitions"

describe("definitions constants", () => {
  it("TOOL_CATEGORIES has the expected category keys", () => {
    expect(Object.keys(TOOL_CATEGORIES)).toEqual(
      expect.arrayContaining([
        "search",
        "file",
        "git",
        "document",
        "academic",
        "media",
        "ppt",
        "learning",
        "system",
      ])
    )
  })

  it("ALL_AVAILABLE_TOOLS flattens the per-category tools", () => {
    expect(ALL_AVAILABLE_TOOLS).toContain("web_search")
    expect(ALL_AVAILABLE_TOOLS).toContain("file_read")
    expect(ALL_AVAILABLE_TOOLS.length).toBe(
      Object.values(TOOL_CATEGORIES).reduce((acc, cat) => acc + cat.tools.length, 0)
    )
  })

  it("TOOL_REQUIREMENTS documents API key and desktop-only requirements", () => {
    expect(TOOL_REQUIREMENTS.web_search.requiresApiKey).toBe("search")
    expect(TOOL_REQUIREMENTS.image_generate.requiresApiKey).toBe("openai")
    expect(TOOL_REQUIREMENTS.execute_code.desktopOnly).toBe(true)
  })

  it("MODE_TEMPLATES contains every named template", () => {
    const ids = MODE_TEMPLATES.map((t) => t.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        "coding-assistant",
        "research-analyst",
        "content-writer",
        "data-analyst",
        "ui-designer",
        "presentation-creator",
        "learning-tutor",
        "translation-assistant",
      ])
    )
  })

  it("AVAILABLE_MODE_ICONS lists at least 50 lucide icon names", () => {
    expect(AVAILABLE_MODE_ICONS.length).toBeGreaterThan(50)
  })
})

describe("checkToolAvailability", () => {
  it("returns the tool as available when no requirement is registered", () => {
    const result = checkToolAvailability(["calculator"], {})
    expect(result.available).toEqual(["calculator"])
    expect(result.unavailable).toEqual([])
  })

  it("blocks API-key gated tools when key is missing", () => {
    const result = checkToolAvailability(["web_search", "image_generate"], {})
    expect(result.available).toEqual([])
    expect(result.unavailable.map((u) => u.tool).sort()).toEqual(["image_generate", "web_search"])
  })

  it("admits API-key gated tools when key is provided", () => {
    const result = checkToolAvailability(["web_search", "image_generate"], {
      search: true,
      openai: true,
    })
    expect(result.available).toEqual(["web_search", "image_generate"])
    expect(result.unavailable).toEqual([])
  })

  it("blocks desktop-only tools in web mode", () => {
    const result = checkToolAvailability(["execute_code", "file_write"], {})
    expect(result.unavailable.map((u) => u.tool)).toEqual(
      expect.arrayContaining(["execute_code", "file_write"])
    )
  })

  it("admits desktop-only tools when isDesktop=true", () => {
    const result = checkToolAvailability(["file_write"], {}, { isDesktop: true })
    expect(result.available).toEqual(["file_write"])
    expect(result.unavailable).toEqual([])
  })
})

describe("getModeTemplate", () => {
  it("returns the matching template for a known id", () => {
    expect(getModeTemplate("coding-assistant")?.name).toBe("Coding Assistant")
  })

  it("returns undefined for unknown ids", () => {
    expect(getModeTemplate("nope")).toBeUndefined()
  })
})
