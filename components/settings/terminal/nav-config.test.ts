import {
  DEFAULT_TERMINAL_PANEL,
  resolveTerminalPanel,
  TERMINAL_NAV_GROUPS,
  TERMINAL_NAV_ITEMS,
  terminalNavCoversEveryPanel,
} from "./nav-config"

describe("terminal nav-config", () => {
  it("lists every panel exactly once, in rail order", () => {
    const ids = TERMINAL_NAV_ITEMS.map((item) => item.id)
    expect(ids).toEqual([
      "appearance",
      "shell",
      "behavior",
      "productivity",
      "ai",
      "host",
      "agents",
      "profiles",
      "ssh",
      "project",
    ])
    expect(new Set(ids).size).toBe(ids.length)
    expect(TERMINAL_NAV_GROUPS.every((group) => group.items.length > 0)).toBe(true)
  })

  it("has a rail entry for every panel a deep link can name", () => {
    expect(terminalNavCoversEveryPanel()).toBe(true)
  })

  it("narrows a deep link to a known panel", () => {
    expect(resolveTerminalPanel("ssh")).toBe("ssh")
    expect(resolveTerminalPanel("nope")).toBe(DEFAULT_TERMINAL_PANEL)
    expect(resolveTerminalPanel(null)).toBe("appearance")
  })
})
