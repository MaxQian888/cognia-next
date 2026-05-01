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
    expect(Object.keys(TOOL_CATEGORIES).sort()).toEqual(
      [
        "sdk_builtin",
        "cognia_file_extras",
        "cognia_git",
        "cognia_process",
        "cognia_environment",
        "cognia_shell_advanced",
      ].sort()
    )
  })

  it("ALL_AVAILABLE_TOOLS flattens the per-category tools", () => {
    expect(ALL_AVAILABLE_TOOLS).toContain("Bash")
    expect(ALL_AVAILABLE_TOOLS).toContain("Read")
    expect(ALL_AVAILABLE_TOOLS).toContain("mcp__cognia-tools__file_hash")
    expect(ALL_AVAILABLE_TOOLS).toContain("mcp__cognia-tools__git_status")
    expect(ALL_AVAILABLE_TOOLS.length).toBe(
      Object.values(TOOL_CATEGORIES).reduce((acc, cat) => acc + cat.tools.length, 0)
    )
  })

  it("never lists removed/aspirational names from the previous template", () => {
    // These pre-cognia-port names had no implementation behind them. If they
    // creep back in, agents will pick them up via custom modes and silently
    // get nothing back.
    for (const ghost of [
      "web_scraper",
      "document_summarize",
      "image_generate",
      "video_generate",
      "ppt_outline",
      "display_flashcard",
      "academic_search",
      "calculator",
      "execute_code",
      "shell_execute",
      "file_read",
      "file_write",
      "file_list",
      "rag_search",
    ]) {
      expect(ALL_AVAILABLE_TOOLS).not.toContain(ghost)
    }
  })

  it("TOOL_REQUIREMENTS gates the desktop-only tools", () => {
    expect(TOOL_REQUIREMENTS.Bash.desktopOnly).toBe(true)
    expect(TOOL_REQUIREMENTS.Read.desktopOnly).toBe(true)
    expect(TOOL_REQUIREMENTS["mcp__cognia-tools__file_hash"].desktopOnly).toBe(true)
    expect(TOOL_REQUIREMENTS["mcp__cognia-tools__shell_execute_advanced"].desktopOnly).toBe(true)
  })

  it("TOOL_REQUIREMENTS leaves WebSearch/WebFetch available in web mode", () => {
    expect(TOOL_REQUIREMENTS.WebSearch.desktopOnly).toBeUndefined()
    expect(TOOL_REQUIREMENTS.WebFetch.desktopOnly).toBeUndefined()
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

  it("MODE_TEMPLATES tools all reference real tool names", () => {
    const valid = new Set<string>(ALL_AVAILABLE_TOOLS as readonly string[])
    for (const template of MODE_TEMPLATES) {
      for (const tool of template.tools) {
        expect(valid.has(tool)).toBe(true)
      }
    }
  })

  it("AVAILABLE_MODE_ICONS lists at least 50 lucide icon names", () => {
    expect(AVAILABLE_MODE_ICONS.length).toBeGreaterThan(50)
  })
})

describe("checkToolAvailability", () => {
  it("returns the tool as available when no requirement is registered", () => {
    const result = checkToolAvailability(["DefinitelyNotARealTool"], {})
    expect(result.available).toEqual(["DefinitelyNotARealTool"])
    expect(result.unavailable).toEqual([])
  })

  it("blocks desktop-only SDK tools in web mode", () => {
    const result = checkToolAvailability(["Bash", "Read", "Write"], {})
    expect(result.unavailable.map((u) => u.tool).sort()).toEqual(["Bash", "Read", "Write"].sort())
    expect(result.available).toEqual([])
  })

  it("admits desktop-only tools when isDesktop=true", () => {
    const result = checkToolAvailability(
      ["Bash", "mcp__cognia-tools__file_hash"],
      {},
      { isDesktop: true }
    )
    expect(result.available.sort()).toEqual(["Bash", "mcp__cognia-tools__file_hash"].sort())
    expect(result.unavailable).toEqual([])
  })

  it("treats WebSearch/WebFetch as available without API keys", () => {
    const result = checkToolAvailability(["WebSearch", "WebFetch"], {})
    expect(result.available.sort()).toEqual(["WebFetch", "WebSearch"])
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
