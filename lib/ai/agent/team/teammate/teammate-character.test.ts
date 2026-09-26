import type { Character } from "@cognia/agent-config-types"
import {
  teammateBaseAgentId,
  teammateCharacterId,
  teammateSystemPrompt,
  teammateToCharacter,
} from "./teammate-character"
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

describe("teammateToCharacter — backed by a saved agent", () => {
  const reviewer = {
    id: "agent-reviewer",
    name: "Reviewer",
    avatarColor: "red",
    systemPrompt: "Review like a hawk.",
    model: "claude-opus-4-8",
    providerId: "anthropic",
    allowedTools: ["Read", "Grep"],
    mcpServerIds: ["github"],
    skillIds: ["style"],
    pluginSkillIds: ["acme:lint"],
    knowledgeBaseIds: ["kb-guidelines"],
    outputStyle: "concise",
    workingDir: "/elsewhere",
    variant: { baseId: "base", ownFields: ["model"] },
    createdAt: 1,
    updatedAt: 1,
  } as Character

  it("runs on the agent's profile under the teammate's identity", () => {
    const c = teammateToCharacter({
      team: makeTeam(),
      teammate: makeTeammate(),
      resolvedCaps: EMPTY_RESOLVED_CAPABILITIES,
      cwd: "/repo",
      baseAgent: reviewer,
    })
    expect(c).toMatchObject({
      id: teammateCharacterId({ id: "tm1" }),
      name: "Security Reviewer",
      systemPrompt: "Review like a hawk.",
      model: "claude-opus-4-8",
      providerId: "anthropic",
      allowedTools: ["Read", "Grep"],
      mcpServerIds: ["github"],
      skillIds: ["style"],
      pluginSkillIds: ["acme:lint"],
      knowledgeBaseIds: ["kb-guidelines"],
      outputStyle: "concise",
      workingDir: "/repo",
    })
    expect(c.variant).toBeUndefined()
  })

  it("lets the teammate's explicit settings and the team's lists win or widen", () => {
    const c = teammateToCharacter({
      team: makeTeam(),
      teammate: makeTeammate({
        config: { systemPrompt: "Mine.", model: "claude-haiku-4-5", tools: ["Read"] },
      }),
      resolvedCaps: {
        ...EMPTY_RESOLVED_CAPABILITIES,
        mcpServerIds: ["linear"],
        skillIds: ["report"],
      },
      baseAgent: reviewer,
    })
    expect(c.systemPrompt).toBe("Mine.")
    expect(c.model).toBe("claude-haiku-4-5")
    expect(c.allowedTools).toEqual(["Read"])
    expect(c.mcpServerIds).toEqual(["github", "linear"])
    expect(c.skillIds).toEqual(["style", "report"])
    expect(c.pluginSkillIds).toEqual(["acme:lint", "report"])
    expect(c.workingDir).toBeUndefined()
  })

  it("prefers the agent's prompt over the team default", () => {
    expect(
      teammateSystemPrompt({ team: makeTeam(), teammate: makeTeammate(), baseAgent: reviewer })
    ).toBe("Review like a hawk.")
    expect(
      teammateSystemPrompt({
        team: makeTeam(),
        teammate: makeTeammate(),
        baseAgent: reviewer,
        override: "  Dispatch prompt.  ",
      })
    ).toBe("Dispatch prompt.")
    expect(teammateSystemPrompt({ team: makeTeam(), teammate: makeTeammate() })).toBe(
      "Team default prompt."
    )
  })

  it("names the first resolved character id as the backing agent", () => {
    expect(teammateBaseAgentId(EMPTY_RESOLVED_CAPABILITIES)).toBeUndefined()
    expect(
      teammateBaseAgentId({ ...EMPTY_RESOLVED_CAPABILITIES, characterPackIds: ["a", "b"] })
    ).toBe("a")
  })
})

describe("teammateToCharacter — inert A2UI template ids", () => {
  it("ignores a2uiTemplateIds: no teammate run reads them", () => {
    const withTemplates = teammateToCharacter({
      team: makeTeam(),
      teammate: makeTeammate(),
      resolvedCaps: { ...EMPTY_RESOLVED_CAPABILITIES, a2uiTemplateIds: ["tpl-1"] },
    })
    const without = teammateToCharacter({
      team: makeTeam(),
      teammate: makeTeammate(),
      resolvedCaps: EMPTY_RESOLVED_CAPABILITIES,
    })
    expect({ ...withTemplates, createdAt: 0, updatedAt: 0 }).toEqual({
      ...without,
      createdAt: 0,
      updatedAt: 0,
    })
  })
})
