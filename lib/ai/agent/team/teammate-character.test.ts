import { teammateToCharacter, teammateCharacterId } from "./teammate-character"
import {
  EMPTY_RESOLVED_CAPABILITIES,
  type AgentTeam,
  type AgentTeammate,
} from "@/types/agent/agent-team"

function makeTeam(
  overrides: Partial<AgentTeam["config"]> = {}
): Pick<AgentTeam, "name" | "config"> {
  return {
    name: "Reviewers",
    config: {
      maxTeammates: 5,
      maxConcurrentTeammates: 3,
      executionMode: "coordinated",
      displayMode: "expanded",
      defaultSystemPrompt: "Team default prompt.",
      defaultModel: "claude-sonnet-4-6",
      defaultProvider: "anthropic",
      ...overrides,
    },
  }
}

function makeTeammate(overrides: Partial<AgentTeammate> = {}): AgentTeammate {
  return {
    id: "tm1",
    teamId: "team1",
    name: "Security Reviewer",
    description: "Finds vulnerabilities",
    role: "teammate",
    status: "idle",
    config: {},
    completedTaskIds: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    progress: 0,
    createdAt: new Date(0),
    ...overrides,
  }
}

describe("teammateCharacterId", () => {
  it("produces a stable synthetic id", () => {
    expect(teammateCharacterId({ id: "abc" })).toBe("__teammate__:abc")
  })
})

describe("teammateToCharacter", () => {
  it("maps identity + falls back to team defaults", () => {
    const c = teammateToCharacter({
      team: makeTeam(),
      teammate: makeTeammate(),
      resolvedCaps: EMPTY_RESOLVED_CAPABILITIES,
    })
    expect(c.id).toBe("__teammate__:tm1")
    expect(c.name).toBe("Security Reviewer")
    expect(c.systemPrompt).toBe("Team default prompt.")
    expect(c.model).toBe("claude-sonnet-4-6")
    expect(c.providerId).toBe("anthropic")
    expect(c.avatarColor).toBeTruthy()
  })

  it("prefers the teammate's own system prompt + model + provider", () => {
    const c = teammateToCharacter({
      team: makeTeam(),
      teammate: makeTeammate({
        config: { systemPrompt: "Be a skeptic.", model: "claude-opus-4-8", provider: "openai" },
      }),
      resolvedCaps: EMPTY_RESOLVED_CAPABILITIES,
    })
    expect(c.systemPrompt).toBe("Be a skeptic.")
    expect(c.model).toBe("claude-opus-4-8")
    expect(c.providerId).toBe("openai")
  })

  it("lets modelHint win over teammate/team model", () => {
    const c = teammateToCharacter({
      team: makeTeam(),
      teammate: makeTeammate({ config: { model: "claude-opus-4-8" } }),
      resolvedCaps: EMPTY_RESOLVED_CAPABILITIES,
      modelHint: "claude-haiku-4-5",
    })
    expect(c.model).toBe("claude-haiku-4-5")
  })

  it("falls back to the canned prompt when no team default", () => {
    const c = teammateToCharacter({
      team: makeTeam({ defaultSystemPrompt: undefined }),
      teammate: makeTeammate(),
      resolvedCaps: EMPTY_RESOLVED_CAPABILITIES,
    })
    expect(c.systemPrompt).toContain("focused, helpful agent teammate")
  })

  it("maps mcp + skills + native tools from resolved capabilities", () => {
    const c = teammateToCharacter({
      team: makeTeam(),
      teammate: makeTeammate({ config: { tools: ["Read", "Bash"] } }),
      resolvedCaps: {
        ...EMPTY_RESOLVED_CAPABILITIES,
        mcpServerIds: ["mcp-a"],
        skillIds: ["skill-x"],
        nativeAnthropicToolIds: ["computer_20251124", "bash_20250124"],
      },
      cwd: "/repo",
    })
    expect(c.mcpServerIds).toEqual(["mcp-a"])
    // Skills set on BOTH fields so neither resolver drops them.
    expect(c.skillIds).toEqual(["skill-x"])
    expect(c.pluginSkillIds).toEqual(["skill-x"])
    expect(c.allowedTools).toEqual(["Read", "Bash"])
    expect(c.enableComputerUse).toBe(true)
    expect(c.computerUseSettings?.allowedToolIds).toEqual(["computer_20251124", "bash_20250124"])
    expect(c.workingDir).toBe("/repo")
  })

  it("leaves capability fields undefined when nothing is resolved", () => {
    const c = teammateToCharacter({
      team: makeTeam(),
      teammate: makeTeammate(),
      resolvedCaps: EMPTY_RESOLVED_CAPABILITIES,
    })
    expect(c.mcpServerIds).toBeUndefined()
    expect(c.skillIds).toBeUndefined()
    expect(c.pluginSkillIds).toBeUndefined()
    expect(c.allowedTools).toBeUndefined()
    expect(c.enableComputerUse).toBe(false)
    expect(c.computerUseSettings).toBeUndefined()
    expect(c.workingDir).toBeUndefined()
  })
})
