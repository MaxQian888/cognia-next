import { buildAgentModeSessionUpdate, type AgentModeSessionFields } from "./mode-session-update"
import type { AgentModeConfig } from "@/types/agent/agent-mode"

const builtIn: AgentModeConfig = {
  id: "general",
  type: "general",
  name: "General",
  description: "general",
  icon: "Bot",
  systemPrompt: "You are helpful.",
  tools: [],
  outputFormat: "text",
}

describe("buildAgentModeSessionUpdate", () => {
  it("returns id + systemPrompt for a built-in mode without overrides", () => {
    const update = buildAgentModeSessionUpdate(builtIn)
    expect(update).toEqual<AgentModeSessionFields>({
      agentModeId: "general",
      systemPrompt: "You are helpful.",
    })
    expect(update.model).toBeUndefined()
    expect(update.temperature).toBeUndefined()
    expect(update.maxTokens).toBeUndefined()
  })

  it("applies all three overrides when present on a custom mode", () => {
    const custom = {
      ...builtIn,
      id: "custom-1",
      type: "custom" as const,
      modelOverride: "claude-opus-4-7",
      temperatureOverride: 0.4,
      maxTokensOverride: 8192,
    } as unknown as AgentModeConfig

    const update = buildAgentModeSessionUpdate(custom)
    expect(update.agentModeId).toBe("custom-1")
    expect(update.model).toBe("claude-opus-4-7")
    expect(update.temperature).toBe(0.4)
    expect(update.maxTokens).toBe(8192)
  })

  it("applies overrides selectively when only some are set", () => {
    const custom = {
      ...builtIn,
      id: "custom-temp",
      type: "custom" as const,
      temperatureOverride: 0.9,
    } as unknown as AgentModeConfig

    const update = buildAgentModeSessionUpdate(custom)
    expect(update.temperature).toBe(0.9)
    expect(update.model).toBeUndefined()
    expect(update.maxTokens).toBeUndefined()
  })

  it("ignores undefined override values", () => {
    const custom = {
      ...builtIn,
      id: "custom-undef",
      type: "custom" as const,
      modelOverride: undefined,
      temperatureOverride: undefined,
      maxTokensOverride: undefined,
    } as unknown as AgentModeConfig

    const update = buildAgentModeSessionUpdate(custom)
    expect(update.model).toBeUndefined()
    expect(update.temperature).toBeUndefined()
    expect(update.maxTokens).toBeUndefined()
  })

  it("treats temperatureOverride === 0 as 'set' (preserves intent)", () => {
    const custom = {
      ...builtIn,
      id: "custom-zero",
      type: "custom" as const,
      temperatureOverride: 0,
    } as unknown as AgentModeConfig

    const update = buildAgentModeSessionUpdate(custom)
    expect(update.temperature).toBe(0)
  })
})
