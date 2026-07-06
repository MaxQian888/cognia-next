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

  it("sets twinId on the character when the teammate is twin-bound", () => {
    const c = teammateToCharacter({
      team: makeTeam(),
      teammate: makeTeammate({ config: { twinId: "twin-1" } }),
      resolvedCaps: EMPTY_RESOLVED_CAPABILITIES,
    })
    expect(c.twinId).toBe("twin-1")
  })

  it("sets twinSettings on the character when both twinId and twinSettings are present", () => {
    const twinSettings = { enableRag: true, ragTopK: 8 } as never
    const c = teammateToCharacter({
      team: makeTeam(),
      teammate: makeTeammate({ config: { twinId: "twin-1", twinSettings } }),
      resolvedCaps: EMPTY_RESOLVED_CAPABILITIES,
    })
    expect(c.twinSettings).toBe(twinSettings)
  })

  it("leaves twinId and twinSettings undefined when the teammate has no twinId", () => {
    const twinSettings = { enableRag: true, ragTopK: 8 } as never
    const c = teammateToCharacter({
      team: makeTeam(),
      teammate: makeTeammate({ config: { twinSettings } }),
      resolvedCaps: EMPTY_RESOLVED_CAPABILITIES,
    })
    expect(c.twinId).toBeUndefined()
    expect(c.twinSettings).toBeUndefined()
  })
})

describe("teammateToCharacter — OS sandbox (ADR-0028)", () => {
  it("leaves sandbox off by default", () => {
    const c = teammateToCharacter({
      team: makeTeam(),
      teammate: makeTeammate(),
      resolvedCaps: EMPTY_RESOLVED_CAPABILITIES,
    })
    expect(c.sandboxEnabled).toBeUndefined()
    expect(c.sandboxPolicy).toBeUndefined()
  })

  it("inherits the team-level sandbox default", () => {
    const c = teammateToCharacter({
      team: makeTeam({ sandboxEnabled: true }),
      teammate: makeTeammate(),
      resolvedCaps: EMPTY_RESOLVED_CAPABILITIES,
    })
    expect(c.sandboxEnabled).toBe(true)
  })

  it("lets a teammate opt OUT of the team default", () => {
    const c = teammateToCharacter({
      team: makeTeam({ sandboxEnabled: true }),
      teammate: makeTeammate({ config: { sandboxEnabled: false } }),
      resolvedCaps: EMPTY_RESOLVED_CAPABILITIES,
    })
    expect(c.sandboxEnabled).toBeUndefined()
  })

  it("clamps the teammate policy DOWN to the team ceiling", () => {
    const c = teammateToCharacter({
      team: makeTeam({
        sandboxEnabled: true,
        sandboxPolicy: { writableRoots: ["/ws"], network: "off" },
      }),
      teammate: makeTeammate({
        config: {
          sandboxEnabled: true,
          sandboxPolicy: { writableRoots: ["/ws/pkg", "/escape"], network: "on" },
        },
      }),
      resolvedCaps: EMPTY_RESOLVED_CAPABILITIES,
    })
    expect(c.sandboxEnabled).toBe(true)
    // Writable narrowed to under the team root; an `off` ceiling forces offline.
    expect(c.sandboxPolicy?.writableRoots).toEqual(["/ws/pkg"])
    expect(c.sandboxPolicy?.network).toBe("off")
  })
})
