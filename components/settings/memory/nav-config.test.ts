import {
  DEFAULT_MEMORY_PANEL,
  MEMORY_NAV_ITEMS,
  MEMORY_TAB_PARAM,
  resolveMemoryPanel,
} from "./nav-config"

describe("memory navigation config", () => {
  it("keeps every settings panel in a stable order", () => {
    expect(MEMORY_NAV_ITEMS.map((item) => item.id)).toEqual([
      "overview",
      "learning",
      "retrieval",
      "projectContext",
      "maintenance",
      "privacy",
    ])
    expect(MEMORY_TAB_PARAM).toBe("memoryTab")
  })

  it("accepts known deep links and falls back for untrusted values", () => {
    expect(resolveMemoryPanel("retrieval")).toBe("retrieval")
    expect(resolveMemoryPanel("projectContext")).toBe("projectContext")
    expect(resolveMemoryPanel("unknown")).toBe(DEFAULT_MEMORY_PANEL)
    expect(resolveMemoryPanel(null)).toBe(DEFAULT_MEMORY_PANEL)
  })
})
