/**
 * @jest-environment jsdom
 */
import {
  PROMPT_TEMPLATE_VARIABLES,
  processPromptTemplateVariables,
  getTemplateVariablePreview,
  getRecommendedMcpToolsForMode,
  autoSelectMcpToolsForMode,
} from "./helpers"
import { analyzeModeDescription } from "./helpers"
import { initialState } from "./initial-state"
import * as barrel from "./index"
import { useCustomModeStore } from "./store"

jest.mock("@/lib/logging", () => {
  const child = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: () => child,
  }
  return { loggers: { agent: { ...child, child: () => child } } }
})

describe("custom-mode-store barrel", () => {
  it("re-exports public API", () => {
    expect(barrel.useCustomModeStore).toBe(useCustomModeStore)
    expect(typeof barrel.PROMPT_TEMPLATE_VARIABLES).toBe("object")
    expect(typeof barrel.processPromptTemplateVariables).toBe("function")
    expect(typeof barrel.getTemplateVariablePreview).toBe("function")
    expect(typeof barrel.getRecommendedMcpToolsForMode).toBe("function")
    expect(typeof barrel.autoSelectMcpToolsForMode).toBe("function")
    expect(typeof barrel.checkToolAvailability).toBe("function")
    expect(typeof barrel.getModeTemplate).toBe("function")
    expect(barrel.AVAILABLE_MODE_ICONS.length).toBeGreaterThan(0)
  })
})

describe("custom-mode-store initial-state", () => {
  it("matches the expected default shape", () => {
    expect(initialState).toEqual({
      customModes: {},
      activeModeId: null,
      isGenerating: false,
      generationError: null,
    })
  })
})

describe("PROMPT_TEMPLATE_VARIABLES", () => {
  it("documents the supported variables", () => {
    expect(Object.keys(PROMPT_TEMPLATE_VARIABLES)).toEqual(
      expect.arrayContaining([
        "{{date}}",
        "{{time}}",
        "{{datetime}}",
        "{{weekday}}",
        "{{timezone}}",
        "{{language}}",
        "{{tools_list}}",
        "{{mode_name}}",
        "{{mode_description}}",
      ])
    )
  })
})

describe("processPromptTemplateVariables", () => {
  it("returns the input unchanged when prompt is empty", () => {
    expect(processPromptTemplateVariables("")).toBe("")
    expect(processPromptTemplateVariables(null as unknown as string)).toBe(
      null as unknown as string
    )
  })

  it("replaces every supported variable with the provided context", () => {
    const out = processPromptTemplateVariables(
      "Hello {{mode_name}} on {{date}}, tools: {{tools_list}} ({{language}}/{{timezone}})",
      {
        modeName: "Coder",
        modeDescription: "writes code",
        tools: ["a", "b"],
        language: "en-US",
        timezone: "UTC",
      }
    )
    expect(out).toContain("Coder")
    expect(out).toContain("a, b")
    expect(out).toContain("en-US")
    expect(out).toContain("UTC")
    // {{date}} is the YYYY-MM-DD prefix of an ISO timestamp
    expect(out).toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  it("falls back to defaults when no context is supplied", () => {
    const out = processPromptTemplateVariables(
      "{{mode_name}} :: {{mode_description}} :: {{tools_list}}"
    )
    expect(out).toContain("Custom Mode")
    expect(out).toContain("No specific tools configured")
  })

  it("uses the 'en' language fallback when navigator is unavailable (node/sidecar path)", () => {
    const orig = Object.getOwnPropertyDescriptor(globalThis, "navigator")
    // The sidecar builds agent-mode prompts in Node, where `navigator` is not
    // a declared global — an unguarded `navigator?.language` would throw a
    // ReferenceError (optional chaining does not guard an undeclared binding).
    Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true })
    try {
      expect(processPromptTemplateVariables("lang={{language}}", {})).toBe("lang=en")
    } finally {
      if (orig) Object.defineProperty(globalThis, "navigator", orig)
      else delete (globalThis as { navigator?: unknown }).navigator
    }
  })
})

describe("getTemplateVariablePreview", () => {
  it("returns concrete values for every documented variable", () => {
    const preview = getTemplateVariablePreview()
    expect(Object.keys(preview)).toEqual(
      expect.arrayContaining(Object.keys(PROMPT_TEMPLATE_VARIABLES))
    )
    expect(preview["{{tools_list}}"]).toBe("No specific tools configured")
    expect(preview["{{mode_name}}"]).toBe("Custom Mode")
    expect(preview["{{language}}"]).toBe("en")
  })

  it("respects the provided context", () => {
    const preview = getTemplateVariablePreview({
      tools: ["read", "write"],
      modeName: "Mode!",
      modeDescription: "desc",
      language: "zh",
      timezone: "Asia/Shanghai",
    })
    expect(preview["{{tools_list}}"]).toBe("read, write")
    expect(preview["{{mode_name}}"]).toBe("Mode!")
    expect(preview["{{mode_description}}"]).toBe("desc")
    expect(preview["{{language}}"]).toBe("zh")
    expect(preview["{{timezone}}"]).toBe("Asia/Shanghai")
  })
})

describe("getRecommendedMcpToolsForMode", () => {
  it("returns scored tools, with category boost applied", () => {
    const recommended = getRecommendedMcpToolsForMode(
      [
        { serverId: "git", toolName: "code_runner", displayName: "Run code" },
        { serverId: "fs", toolName: "list_files", displayName: "List files" },
      ],
      {
        name: "Coder",
        description: "writes code",
        systemPrompt: "you are a coder",
        category: "technical",
      }
    )
    expect(recommended.length).toBeGreaterThan(0)
    // The first tool's name contains "code" → category boost applied
    const codeTool = recommended.find((t) => t.toolName === "code_runner")
    expect(codeTool?.relevanceScore).toBeGreaterThanOrEqual(0.5)
  })

  it("falls back gracefully when category is unrecognized", () => {
    const recommended = getRecommendedMcpToolsForMode(
      [{ serverId: "x", toolName: "search_web", displayName: "Search web" }],
      {
        name: "X",
        description: "find things",
        systemPrompt: "system",
        category: "personal",
      }
    )
    expect(recommended).toHaveLength(1)
  })

  it("respects the limit option", () => {
    const recommended = getRecommendedMcpToolsForMode(
      [
        { serverId: "a", toolName: "tool-a" },
        { serverId: "b", toolName: "tool-b" },
        { serverId: "c", toolName: "tool-c" },
      ],
      { name: "n", description: "d", systemPrompt: "s", category: "research" },
      2
    )
    expect(recommended.length).toBeLessThanOrEqual(2)
  })
})

describe("autoSelectMcpToolsForMode", () => {
  it("strips relevanceScore from the recommended set", () => {
    const out = autoSelectMcpToolsForMode(
      [{ serverId: "x", toolName: "tool-x" }],
      "use anything",
      5
    )
    expect(out).toEqual([{ serverId: "x", toolName: "tool-x" }])
    expect((out[0] as unknown as { relevanceScore?: number }).relevanceScore).toBeUndefined()
  })

  it("returns empty array when no tools are available", () => {
    expect(autoSelectMcpToolsForMode([], "anything")).toEqual([])
  })
})

describe("analyzeModeDescription (private but exported)", () => {
  it("matches the coding pattern when keywords are present", () => {
    const result = analyzeModeDescription({ description: "coding assistant for software" })
    expect(result.suggestedTools).toContain("file_read")
    expect(result.confidence).toBeGreaterThan(0.5)
    expect(result.mode.outputFormat).toBe("code")
  })

  it("matches the research pattern", () => {
    const result = analyzeModeDescription({
      description: "academic research and paper analysis",
    })
    expect(result.suggestedTools).toEqual(
      expect.arrayContaining(["academic_search", "academic_analysis"])
    )
  })

  it("matches the design pattern and toggles preview", () => {
    const result = analyzeModeDescription({
      description: "design a beautiful web interface",
    })
    expect(result.mode.previewEnabled).toBe(true)
    expect(result.mode.outputFormat).toBe("react")
  })

  it("emits an A2UI template when requested", () => {
    const result = analyzeModeDescription({
      description: "research helper",
      includeA2UI: true,
    })
    expect(result.suggestedA2UITemplate).toBeDefined()
    expect(result.suggestedA2UITemplate!.components.length).toBeGreaterThan(0)
    expect(result.suggestedA2UITemplate!.actions?.length).toBeGreaterThan(0)
  })

  it("falls back to the default pattern when no keyword matches", () => {
    const result = analyzeModeDescription({
      description: "qweasdf",
      includeA2UI: true,
    })
    expect(result.confidence).toBe(0.3)
    expect(result.mode.outputFormat).toBe("text")
    expect(result.mode.icon).toBe("Bot")
    expect(result.suggestedA2UITemplate).toBeDefined()
  })

  it("matches the writing / data / presentation / learning patterns", () => {
    expect(analyzeModeDescription({ description: "blog and article writing" }).mode.icon).toBe(
      "PenTool"
    )
    expect(analyzeModeDescription({ description: "analytics on data and chart" }).mode.icon).toBe(
      "BarChart3"
    )
    expect(analyzeModeDescription({ description: "ppt presentation and slide" }).mode.icon).toBe(
      "Presentation"
    )
    expect(analyzeModeDescription({ description: "tutor and learn" }).mode.icon).toBe("BookOpen")
  })

  it("extracts a custom name via the create/make/build heuristic", () => {
    expect(analyzeModeDescription({ description: "create CodingHero" }).mode.name).toBe(
      "CodingHero"
    )
  })

  it("extracts a name via the helper/assistant/mode heuristic", () => {
    expect(analyzeModeDescription({ description: "ResearchAssistant for papers" }).mode.name).toBe(
      "Research"
    )
  })
})
