import { buildQuickActions } from "./build-quick-actions"
import type { ResolvedConfig } from "../../config/schema"

function makeConfig(over: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    provider: "anthropic",
    providers: {},
    permissionMode: "default",
    cwd: "/repo",
    ...over,
  } as ResolvedConfig
}

describe("buildQuickActions", () => {
  it("includes the core command-center rows, each with a slash command", () => {
    const rows = buildQuickActions(makeConfig())
    const ids = rows.map((r) => r.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        "mode",
        "model",
        "provider",
        "thinking",
        "settings",
        "mcp",
        "skills",
        "agents",
        "usage",
        "context",
        "diff",
        "theme",
        "mouse",
        "help",
      ])
    )
    for (const row of rows) {
      expect(row.command.startsWith("/")).toBe(true)
      expect(row.label.length).toBeGreaterThan(0)
    }
  })

  it("surfaces the current permission mode and provider as hints", () => {
    const rows = buildQuickActions(makeConfig({ permissionMode: "plan", provider: "openai" }))
    expect(rows.find((r) => r.id === "mode")?.hint).toBe("plan")
    expect(rows.find((r) => r.id === "provider")?.hint).toBe("openai")
  })

  it("shows 'off' for the thinking row when no level is set", () => {
    expect(buildQuickActions(makeConfig()).find((r) => r.id === "thinking")?.hint).toBe("off")
  })

  it("reflects an active thinking level", () => {
    const rows = buildQuickActions(makeConfig({ thinkingLevel: "high" }))
    expect(rows.find((r) => r.id === "thinking")?.hint).toBe("high")
  })

  it("defaults the mouse hint when unset and reflects an explicit model", () => {
    expect(buildQuickActions(makeConfig()).find((r) => r.id === "mouse")?.hint).toBeTruthy()
    const rows = buildQuickActions(makeConfig({ mouse: "select" }))
    expect(rows.find((r) => r.id === "mouse")?.hint).toBe("select")
  })

  it("ids are unique (stable React keys)", () => {
    const ids = buildQuickActions(makeConfig()).map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
