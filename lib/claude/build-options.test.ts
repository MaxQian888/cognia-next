// Mock every database / store / agent-mode dependency so build-options can be
// exercised as a pure function. We never want to touch Dexie or Zustand here.

jest.mock("@/lib/db/characters", () => ({
  // ADR-0030: build-options switched to resolveCharacterById so plugin-
  // overlay characters resolve through the same path as Dexie rows.
  resolveCharacterById: jest.fn(),
  listCharactersByIds: jest.fn(),
}))

jest.mock("@/lib/db/skills", () => ({
  listEnabledSkillsByIds: jest.fn(),
  recordSkillUsage: jest.fn(),
  renderSkillsSection: jest.fn(),
}))

jest.mock("@/lib/db/mcp-servers", () => ({
  listEnabledMcpServers: jest.fn(),
  buildMcpServerMap: jest.fn(),
}))

jest.mock("@/lib/db/teams", () => ({
  getTeam: jest.fn(),
}))

jest.mock("@/stores/agent", () => ({
  useAgentRuntimeStore: { getState: jest.fn() },
}))

jest.mock("@/stores/agent/custom-mode-store", () => ({
  useCustomModeStore: { getState: jest.fn() },
}))

jest.mock("@/lib/agent", () => ({
  buildAgentModeSessionUpdate: jest.fn(),
}))

jest.mock("@/lib/plugin/bridge/sidecar-tools-bridge", () => ({
  buildPluginToolsManifest: jest.fn(() => []),
}))

jest.mock("@/lib/db/conversation-overrides", () => ({
  readForResolution: jest.fn(),
}))

// ADR-0028 — env-resolver bridges the renderer to the Rust per-account env
// builder. Mock both helpers so resolveSendOptions exercises the integration
// path without a real Tauri transport.
jest.mock("@/lib/claude/env-resolver", () => ({
  resolveAccountId: jest.fn(),
  resolveAccountEnv: jest.fn(),
  resolveProxyEnv: jest.fn(),
}))

// Twin runtime is dynamically imported by resolveSendOptions; the mock only
// kicks in when a test supplies twinId + twinDeps + twinUserMessage.
const mApplyTwinContext = jest.fn()
jest.mock("@/lib/twin/runtime", () => ({
  applyTwinContext: (...args: unknown[]) => mApplyTwinContext(...args),
}))

import { buildAgentModeSessionUpdate } from "@/lib/agent"
import { resolveAccountEnv, resolveAccountId, resolveProxyEnv } from "@/lib/claude/env-resolver"
import { listCharactersByIds, resolveCharacterById } from "@/lib/db/characters"
import { buildMcpServerMap, listEnabledMcpServers } from "@/lib/db/mcp-servers"
import { listEnabledSkillsByIds, recordSkillUsage, renderSkillsSection } from "@/lib/db/skills"
import { getTeam } from "@/lib/db/teams"
import { buildPluginToolsManifest } from "@/lib/plugin/bridge/sidecar-tools-bridge"
import { loggers } from "@/lib/logging"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import { useAgentRuntimeStore } from "@/stores/agent"
import { useCustomModeStore } from "@/stores/agent/custom-mode-store"
import type { AgentModeConfig } from "@/types/agent/agent-mode"

import { listTeamMembers, resolveMemberConfig, resolveSendOptions } from "./build-options"
import type { AppSettings, Character, ChatSession, Skill, Team, TeamMember } from "./types"
import type { Project } from "@/types"

const mGetCharacter = resolveCharacterById as jest.Mock
const mListCharsByIds = listCharactersByIds as jest.Mock
const mListSkills = listEnabledSkillsByIds as jest.Mock
const mRecordUsage = recordSkillUsage as jest.Mock
const mRender = renderSkillsSection as jest.Mock
const mListMcp = listEnabledMcpServers as jest.Mock
const mBuildMap = buildMcpServerMap as jest.Mock
const mGetTeam = getTeam as jest.Mock
const mRuntimeGet = (useAgentRuntimeStore as unknown as { getState: jest.Mock }).getState
const mCustomGet = (useCustomModeStore as unknown as { getState: jest.Mock }).getState
const mBuildModeUpdate = buildAgentModeSessionUpdate as jest.Mock
const mResolveAccountId = resolveAccountId as jest.Mock
const mResolveAccountEnv = resolveAccountEnv as jest.Mock
const mResolveProxyEnv = resolveProxyEnv as jest.Mock

function makeChar(p: Partial<Character> = {}): Character {
  return {
    id: p.id ?? "c1",
    name: p.name ?? "Char",
    avatarColor: "oklch(0.7 0 0)",
    systemPrompt: p.systemPrompt ?? "",
    createdAt: 0,
    updatedAt: 0,
    ...p,
  } as Character
}

function makeSession(p: Partial<ChatSession>): ChatSession {
  return {
    id: p.id ?? "s1",
    title: "t",
    kind: p.kind ?? "direct",
    createdAt: 0,
    updatedAt: 0,
    ...p,
  } as ChatSession
}

function makeProject(roots: { id?: string; path: string; isPrimary?: boolean }[]): Project {
  return {
    id: "ws1",
    name: "WS",
    roots: roots.map((r, i) => ({ id: r.id ?? `root-${i}`, path: r.path, isPrimary: r.isPrimary })),
    knowledgeBase: [],
    sessionIds: [],
    sessionCount: 0,
    messageCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastAccessedAt: new Date(),
  } as Project
}

beforeEach(() => {
  jest.clearAllMocks()
  // Sane defaults so the function doesn't error when a test forgets to set
  // an expectation.
  mListSkills.mockResolvedValue([])
  mRecordUsage.mockResolvedValue(undefined)
  mRender.mockReturnValue("")
  mListMcp.mockResolvedValue([])
  mBuildMap.mockReturnValue({})
  mGetTeam.mockResolvedValue(undefined)
  mRuntimeGet.mockReturnValue({ modeId: undefined })
  mCustomGet.mockReturnValue({ customModes: {} })
  mBuildModeUpdate.mockReturnValue(undefined)
  // ADR-0028 — default to the "no account override" path so existing tests
  // see today's behaviour. Per-test overrides activate the new flow.
  mResolveAccountId.mockReturnValue(null)
  mResolveAccountEnv.mockResolvedValue({})
  mResolveProxyEnv.mockResolvedValue({})
})

describe("resolveMemberConfig", () => {
  const team = { id: "t1", mcpServerIds: ["t-mcp-1"] } as Team
  const character = makeChar({
    id: "c1",
    systemPrompt: "char prompt",
    model: "char-model",
    allowedTools: ["A"],
    mcpServerIds: ["c-mcp-1"],
  })

  it("uses overrides where provided", () => {
    const member: TeamMember = {
      characterId: "c1",
      systemPromptOverride: "override prompt",
      modelOverride: "override-model",
      allowedToolsOverride: ["B"],
      mcpServerIdsOverride: ["m-mcp-1"],
    }
    expect(resolveMemberConfig(team, member, character)).toEqual({
      systemPrompt: "override prompt",
      model: "override-model",
      allowedTools: ["B"],
      mcpServerIds: ["m-mcp-1"],
    })
  })

  it("falls back to the character defaults when no override is set", () => {
    const member: TeamMember = { characterId: "c1" }
    expect(resolveMemberConfig(team, member, character)).toEqual({
      systemPrompt: "char prompt",
      model: "char-model",
      allowedTools: ["A"],
      mcpServerIds: ["c-mcp-1"],
    })
  })

  it("falls through to team mcp when neither override nor character has any", () => {
    const member: TeamMember = { characterId: "c1" }
    const charNoMcp = makeChar({ id: "c1" })
    expect(resolveMemberConfig(team, member, charNoMcp).mcpServerIds).toEqual(["t-mcp-1"])
  })
})

describe("resolveSendOptions — plugin tools manifest failure", () => {
  it("logs (does not silently swallow) a plugin-tools manifest build failure", async () => {
    const warnSpy = jest.spyOn(loggers.app, "warn").mockImplementation(() => {})
    ;(buildPluginToolsManifest as jest.Mock).mockImplementationOnce(() => {
      throw new Error("boom")
    })
    await resolveSendOptions({ character: makeChar({ id: "c1" }) })
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("plugin tools manifest"),
      expect.objectContaining({ error: expect.stringContaining("boom") })
    )
    warnSpy.mockRestore()
  })
})

describe("resolveSendOptions — non-Anthropic provider credentials (ADR-0043)", () => {
  it("forwards the resolved protocol + modelParams for a configured built-in provider", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", providerId: "openai", model: "gpt-4o-mini" }),
      appSettings: {
        defaultProvider: "openai",
        providerSettings: {
          openai: { apiKey: "sk-test", inferenceDefaults: { temperature: 0.5, maxTokens: 1024 } },
        },
      } as unknown as AppSettings,
    })
    expect(opts.provider).toBe("openai")
    // Unconditional protocol forwarding (previously custom-only → undefined).
    expect(opts.providerCredentials?.protocol).toBe("openai")
    // Configured inference defaults reach the turn (v6 `maxTokens → maxOutputTokens`).
    expect(opts.modelParams).toEqual(
      expect.objectContaining({ temperature: 0.5, maxOutputTokens: 1024 })
    )
  })
})

describe("resolveSendOptions — agent-mode prompt template variables", () => {
  it("substitutes {{date}} / {{tools_list}} in the active mode's system prompt", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", systemPrompt: "base" }),
      agentMode: {
        id: "m1",
        type: "custom",
        name: "Tester",
        description: "",
        icon: "Bot",
        systemPrompt: "Mode prompt. Today is {{date}}. Tools: {{tools_list}}.",
        tools: ["calculator"],
      } as AgentModeConfig,
    })
    expect(opts.systemPrompt).toBeDefined()
    expect(opts.systemPrompt).not.toContain("{{date}}")
    expect(opts.systemPrompt).not.toContain("{{tools_list}}")
    expect(opts.systemPrompt).toContain("calculator")
  })
})

describe("resolveSendOptions — direct-chat subagents (opts.agents)", () => {
  it("exposes the user's non-built-in subagent templates to direct chat", async () => {
    useSubagentRuntimeStore.getState().addTemplate({
      id: "bo-direct-1",
      name: "BO Helper",
      description: "helps",
      category: "general",
      taskTemplate: "do {{x}}",
      config: { systemPrompt: "You help.", tools: ["t"] },
      isBuiltIn: false,
    })
    try {
      const opts = await resolveSendOptions({ character: makeChar({ id: "c1" }) })
      expect(opts.agents?.["template:bo-helper"]).toMatchObject({
        description: "helps",
        prompt: "You help.",
      })
    } finally {
      useSubagentRuntimeStore.getState().deleteTemplate("bo-direct-1")
    }
  })
})

describe("resolveSendOptions — character + skills", () => {
  it("loads the character from the session id when not provided directly", async () => {
    mGetCharacter.mockResolvedValueOnce(
      makeChar({ id: "c1", model: "from-char", systemPrompt: "from-char-sys" })
    )
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", characterId: "c1" }),
    })
    expect(mGetCharacter).toHaveBeenCalledWith("c1")
    expect(opts.model).toBe("from-char")
    expect(opts.systemPrompt).toBe("from-char-sys")
  })

  it("treats undefined character as null when resolveCharacterById resolves undefined", async () => {
    mGetCharacter.mockResolvedValueOnce(undefined)
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", characterId: "c-missing" }),
    })
    expect(opts.systemPrompt).toBeUndefined()
  })

  it("loads skills attached to the character and respects session-disable list", async () => {
    const ch = makeChar({ id: "c1", skillIds: ["sk1", "sk2"] })
    const skills: Skill[] = [
      {
        id: "sk1",
        name: "Skill 1",
        description: "",
        content: "body 1",
        allowedTools: ["X"],
      } as unknown as Skill,
    ]
    mListSkills.mockResolvedValueOnce(skills)
    mRender.mockReturnValueOnce("## Skill 1\n\nbody 1")

    const opts = await resolveSendOptions({
      character: ch,
      session: makeSession({ id: "s1", disabledSkillIds: ["sk2"] }),
    })

    // Only sk1 was passed to the loader (sk2 was disabled on the session).
    expect(mListSkills).toHaveBeenCalledWith(["sk1"])
    expect(mRecordUsage).toHaveBeenCalledWith(["sk1"])
    expect(opts.systemPrompt).toContain("Skill 1")
    expect(opts.allowedTools).toEqual(expect.arrayContaining(["X"]))
  })

  it("recordSkillUsage failures are swallowed and don't propagate", async () => {
    const ch = makeChar({ id: "c1", skillIds: ["sk1"] })
    mListSkills.mockResolvedValueOnce([
      { id: "sk1", name: "Sk", content: "body", allowedTools: [] } as unknown as Skill,
    ])
    mRecordUsage.mockRejectedValueOnce(new Error("dexie down"))
    mRender.mockReturnValueOnce("body")

    await expect(resolveSendOptions({ character: ch })).resolves.toBeDefined()
  })

  it("skips skills altogether when the character has no skillIds", async () => {
    const ch = makeChar({ id: "c1" })
    await resolveSendOptions({ character: ch })
    expect(mListSkills).not.toHaveBeenCalled()
    expect(mRecordUsage).not.toHaveBeenCalled()
  })

  it("unions ephemeralSkillIds with character.skillIds and de-dupes", async () => {
    const ch = makeChar({ id: "c1", skillIds: ["sk1"] })
    mListSkills.mockResolvedValueOnce([
      { id: "sk1", name: "S1", content: "body1" } as unknown as Skill,
      { id: "sk2", name: "S2", content: "body2" } as unknown as Skill,
    ])
    mRender.mockReturnValueOnce("rendered")
    await resolveSendOptions({ character: ch, ephemeralSkillIds: ["sk1", "sk2"] })
    // Character + ephemeral merged, de-duped — sk1 appears once.
    expect(mListSkills).toHaveBeenCalledWith(["sk1", "sk2"])
  })

  it("respects session-disable list against ephemeral skills too", async () => {
    const ch = makeChar({ id: "c1" })
    mListSkills.mockResolvedValueOnce([
      { id: "sk2", name: "S2", content: "body" } as unknown as Skill,
    ])
    mRender.mockReturnValueOnce("rendered")
    await resolveSendOptions({
      character: ch,
      ephemeralSkillIds: ["sk1", "sk2"],
      session: makeSession({ id: "s1", disabledSkillIds: ["sk1"] }),
    })
    expect(mListSkills).toHaveBeenCalledWith(["sk2"])
  })

  it("calls recordSkillUsage on the merged ephemeral + character set", async () => {
    const ch = makeChar({ id: "c1", skillIds: ["sk1"] })
    mListSkills.mockResolvedValueOnce([
      { id: "sk1", name: "A", content: "x" } as unknown as Skill,
      { id: "sk2", name: "B", content: "y" } as unknown as Skill,
    ])
    mRender.mockReturnValueOnce("rendered")
    await resolveSendOptions({ character: ch, ephemeralSkillIds: ["sk2"] })
    expect(mRecordUsage).toHaveBeenCalledWith(["sk1", "sk2"])
  })

  it("union-merges allowed tools across character + skills + active mode", async () => {
    const ch = makeChar({ id: "c1", allowedTools: ["A", "B"] })
    mListSkills.mockResolvedValueOnce([
      { id: "sk", name: "Sk", content: "x", allowedTools: ["B", "C"] } as unknown as Skill,
    ])
    mRender.mockReturnValueOnce("section")
    const mode: AgentModeConfig = {
      id: "code-gen",
      type: "code-gen",
      name: "Code",
      description: "",
      icon: "Code2",
      tools: ["D"],
    }
    mBuildModeUpdate.mockReturnValueOnce({ agentModeId: "code-gen" })

    const opts = await resolveSendOptions({
      character: { ...ch, skillIds: ["sk"] } as Character,
      agentMode: mode,
    })
    expect(opts.allowedTools?.sort()).toEqual(["A", "B", "C", "D"])
  })

  it("emits disallowedTools straight from the character", async () => {
    const ch = makeChar({ id: "c1", disallowedTools: ["DangerousTool"] })
    const opts = await resolveSendOptions({ character: ch })
    expect(opts.disallowedTools).toEqual(["DangerousTool"])
  })
})

describe("resolveSendOptions — model precedence", () => {
  it("session.model wins over everything", async () => {
    const ch = makeChar({ id: "c1", model: "char" })
    const session = makeSession({ id: "s1", model: "session-model" })
    mBuildModeUpdate.mockReturnValueOnce({ agentModeId: "x", model: "mode-model" })
    const opts = await resolveSendOptions({
      character: ch,
      session,
      appSettings: { defaultModel: "default" } as AppSettings,
      memberOverride: { characterId: "c1", modelOverride: "member" },
      agentMode: {
        id: "x",
        type: "code-gen",
        name: "x",
        description: "",
        icon: "Bot",
      } as AgentModeConfig,
    })
    expect(opts.model).toBe("session-model")
  })

  it("falls through to memberOverride > mode > character > app default", async () => {
    const ch = makeChar({ id: "c1", model: "char" })
    const opts = await resolveSendOptions({
      character: ch,
      memberOverride: { characterId: "c1", modelOverride: "member" },
    })
    expect(opts.model).toBe("member")

    mBuildModeUpdate.mockReturnValueOnce({ agentModeId: "x", model: "mode" })
    const opts2 = await resolveSendOptions({
      character: ch,
      agentMode: {
        id: "x",
        type: "code-gen",
        name: "x",
        description: "",
        icon: "Bot",
      } as AgentModeConfig,
    })
    expect(opts2.model).toBe("mode")

    const opts3 = await resolveSendOptions({ character: ch })
    expect(opts3.model).toBe("char")

    const opts4 = await resolveSendOptions({
      appSettings: { defaultModel: "fallback" } as AppSettings,
    })
    expect(opts4.model).toBe("fallback")

    const opts5 = await resolveSendOptions({})
    expect(opts5.model).toBeUndefined()
  })

  // v41 / A6 — per-channel provider+model override is the topmost rung of
  // the precedence chain. Inbox conversation-header edits write to the
  // ConversationOverrideRow; the resolver reads that row once per send.
  it("IM ConversationOverrideRow.providerOverride/modelOverride sit above session, character, app", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const overrides = require("@/lib/db/conversation-overrides")
    const mReadOverride = overrides.readForResolution as jest.Mock
    mReadOverride.mockResolvedValueOnce({
      providerOverride: "codex",
      modelOverride: "gpt-5",
    })
    const opts = await resolveSendOptions({
      session: makeSession({
        id: "s1",
        model: "session-model",
        providerOverride: "anthropic",
        platformBinding: {
          adapterId: "tg-1",
          conversationKey: "telegram:tg-1:9",
        },
      } as ChatSession),
      character: makeChar({ id: "c1", model: "char", providerId: "openai" }),
      appSettings: {
        defaultModel: "app-default",
        defaultProvider: "anthropic",
      } as AppSettings,
    })
    // IM override wins on both axes.
    expect(opts.model).toBe("gpt-5")
    expect(opts.provider).toBe("codex")
  })

  it("IM override falls through to session.providerOverride when only one axis is set", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const overrides = require("@/lib/db/conversation-overrides")
    const mReadOverride = overrides.readForResolution as jest.Mock
    mReadOverride.mockResolvedValueOnce({ modelOverride: "gpt-5" })
    const opts = await resolveSendOptions({
      session: makeSession({
        id: "s1",
        providerOverride: "openai",
        platformBinding: {
          adapterId: "tg-1",
          conversationKey: "telegram:tg-1:9",
        },
      } as ChatSession),
      character: makeChar({ id: "c1", model: "char", providerId: "anthropic" }),
    })
    expect(opts.model).toBe("gpt-5")
    // No providerOverride on the row → falls through to session.providerOverride.
    expect(opts.provider).toBe("openai")
  })

  it("non-IM sessions ignore the row read (precedence unchanged)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const overrides = require("@/lib/db/conversation-overrides")
    const mReadOverride = overrides.readForResolution as jest.Mock
    mReadOverride.mockResolvedValueOnce({
      providerOverride: "codex",
      modelOverride: "gpt-5",
    })
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", model: "session-model" }),
      character: makeChar({ id: "c1", providerId: "anthropic" }),
    })
    // Without platformBinding, the resolver MUST NOT issue the override
    // read — the mock is harmless because nothing consumes it.
    expect(opts.model).toBe("session-model")
    expect(opts.provider).toBe("anthropic")
  })
})

describe("resolveSendOptions — system prompt assembly", () => {
  it("joins base + mode + skill sections with the canonical separator", async () => {
    const ch = makeChar({ id: "c1", systemPrompt: "base", skillIds: ["s1"] })
    mListSkills.mockResolvedValueOnce([
      { id: "s1", name: "Sk", content: "body", allowedTools: [] } as unknown as Skill,
    ])
    mRender.mockReturnValueOnce("## Sk\n\nbody")
    mBuildModeUpdate.mockReturnValueOnce({ agentModeId: "x" })
    const opts = await resolveSendOptions({
      character: ch,
      agentMode: {
        id: "x",
        type: "code-gen",
        name: "x",
        description: "",
        icon: "Bot",
        systemPrompt: "mode prompt",
      } as AgentModeConfig,
    })
    expect(opts.systemPrompt).toBe("base\n\n---\n\nmode prompt\n\n---\n\n## Sk\n\nbody")
  })

  it("memberOverride.systemPromptOverride replaces the character prompt", async () => {
    const ch = makeChar({ id: "c1", systemPrompt: "char" })
    const opts = await resolveSendOptions({
      character: ch,
      memberOverride: { characterId: "c1", systemPromptOverride: "member" },
    })
    expect(opts.systemPrompt).toBe("member")
  })

  it("session.systemPrompt overrides everything", async () => {
    const ch = makeChar({ id: "c1", systemPrompt: "char" })
    const opts = await resolveSendOptions({
      character: ch,
      session: makeSession({ id: "s1", systemPrompt: "session" }),
      memberOverride: { characterId: "c1", systemPromptOverride: "member" },
    })
    expect(opts.systemPrompt).toBe("session")
  })

  it("falls back to appSettings.defaultSystemPrompt", async () => {
    const opts = await resolveSendOptions({
      appSettings: { defaultSystemPrompt: "default" } as AppSettings,
    })
    expect(opts.systemPrompt).toBe("default")
  })

  it("omits systemPrompt when nothing produces a non-empty string", async () => {
    const opts = await resolveSendOptions({})
    expect(opts.systemPrompt).toBeUndefined()
  })

  it("appends the v2 persona section (tone + personality) after the base prompt", async () => {
    const ch = makeChar({
      id: "c1",
      systemPrompt: "base",
      persona: { tone: "warm, encouraging", personality: "Former teacher, uses analogies." },
    })
    const opts = await resolveSendOptions({ character: ch })
    expect(opts.systemPrompt).toBe(
      "base\n\n---\n\n## Persona\n\nTone: warm, encouraging\n\nFormer teacher, uses analogies."
    )
  })

  it("omits the persona section when tone and personality are blank", async () => {
    const ch = makeChar({
      id: "c1",
      systemPrompt: "base",
      persona: { openingMessage: "hi there", exemplarPrompts: ["do x"] },
    })
    const opts = await resolveSendOptions({ character: ch })
    expect(opts.systemPrompt).toBe("base")
  })

  it("suppresses the persona section when the twin runtime replaced the base prompt", async () => {
    mApplyTwinContext.mockResolvedValueOnce({
      applied: { systemPrompt: "TWIN PROMPT" },
      retrievedChunks: [],
      selectedStyleSamples: [],
      degraded: false,
    })
    const ch = makeChar({
      id: "c1",
      systemPrompt: "base",
      twinId: "twin1",
      persona: { tone: "warm", personality: "Former teacher." },
    })
    const opts = await resolveSendOptions({
      character: ch,
      twinDeps: {} as never,
      twinUserMessage: "hello",
    })
    expect(opts.systemPrompt).toBe("TWIN PROMPT")
    expect(opts.systemPrompt).not.toContain("## Persona")
  })
})

describe("resolveSendOptions — agent mode resolution", () => {
  it("ctx.agentMode === null opts the turn out of mode application", async () => {
    mBuildModeUpdate.mockReturnValue({ agentModeId: "should-not-run" })
    mRuntimeGet.mockReturnValue({ modeId: "general" })

    const opts = await resolveSendOptions({ agentMode: null })
    expect(mBuildModeUpdate).not.toHaveBeenCalled()
    expect(opts.systemPrompt).toBeUndefined()
  })

  it("falls back to the runtime store when ctx.agentMode is undefined", async () => {
    mRuntimeGet.mockReturnValue({ modeId: "general" })
    await resolveSendOptions({})
    // BUILT_IN_AGENT_MODES contains general → buildAgentModeSessionUpdate runs.
    expect(mBuildModeUpdate).toHaveBeenCalled()
  })

  it("looks up custom modes by id when not built-in", async () => {
    const custom: AgentModeConfig = {
      id: "custom-1",
      type: "custom",
      name: "Custom",
      description: "",
      icon: "Bot",
      tools: ["tool-x"],
    }
    mRuntimeGet.mockReturnValue({ modeId: "custom-1" })
    mCustomGet.mockReturnValue({ customModes: { "custom-1": custom } })
    mBuildModeUpdate.mockReturnValue({ agentModeId: "custom-1" })

    const opts = await resolveSendOptions({})
    expect(opts.allowedTools).toEqual(expect.arrayContaining(["tool-x"]))
  })

  it("returns no mode when modeId is unknown in both registries", async () => {
    mRuntimeGet.mockReturnValue({ modeId: "ghost" })
    mCustomGet.mockReturnValue({ customModes: {} })
    await resolveSendOptions({})
    expect(mBuildModeUpdate).not.toHaveBeenCalled()
  })

  it("returns no mode when modeId is null/undefined", async () => {
    mRuntimeGet.mockReturnValue({ modeId: undefined })
    await resolveSendOptions({})
    expect(mBuildModeUpdate).not.toHaveBeenCalled()
  })
})

describe("resolveSendOptions — referencedPaths", () => {
  it("adds folder paths and parent dirs of files; dedupes", async () => {
    const opts = await resolveSendOptions({
      referencedPaths: [
        { absolute: "/Users/me/folder", isDir: true },
        { absolute: "/Users/me/folder/file.ts", isDir: false },
        { absolute: "/Users/me/folder/file.ts", isDir: false }, // dup
        { absolute: "C:\\work\\sub\\thing.tsx", isDir: false },
        { absolute: "", isDir: true }, // dropped
      ],
    })
    expect(opts.additionalDirectories?.sort()).toEqual(["/Users/me/folder", "C:\\work\\sub"].sort())
  })

  it("omits the field entirely when no usable paths exist", async () => {
    const opts = await resolveSendOptions({
      referencedPaths: [{ absolute: "", isDir: false }],
    })
    expect(opts.additionalDirectories).toBeUndefined()
  })

  it("doesn't add to dirs when the file is at the filesystem root (no separator > index 0)", async () => {
    const opts = await resolveSendOptions({
      referencedPaths: [{ absolute: "/file.ts", isDir: false }],
    })
    expect(opts.additionalDirectories).toBeUndefined()
  })

  it("is a no-op when referencedPaths is empty", async () => {
    const opts = await resolveSendOptions({ referencedPaths: [] })
    expect(opts.additionalDirectories).toBeUndefined()
  })
})

describe("resolveSendOptions — cwd / permissionMode", () => {
  it("session.workingDir wins, then character, then appSettings", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", workingDir: "/sess-dir" }),
      character: makeChar({ workingDir: "/char-dir" }),
      appSettings: { defaultWorkingDir: "/app-dir" } as AppSettings,
    })
    expect(opts.cwd).toBe("/sess-dir")

    const opts2 = await resolveSendOptions({
      character: makeChar({ workingDir: "/char-dir" }),
      appSettings: { defaultWorkingDir: "/app-dir" } as AppSettings,
    })
    expect(opts2.cwd).toBe("/char-dir")

    const opts3 = await resolveSendOptions({
      appSettings: { defaultWorkingDir: "/app-dir" } as AppSettings,
    })
    expect(opts3.cwd).toBe("/app-dir")
  })

  it("permissionMode: session > character > appSettings", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", permissionMode: "plan" }),
      character: makeChar({ permissionMode: "default" }),
      appSettings: { permissionMode: "acceptEdits" } as AppSettings,
    })
    expect(opts.permissionMode).toBe("plan")

    const opts2 = await resolveSendOptions({
      character: makeChar({ permissionMode: "default" }),
    })
    expect(opts2.permissionMode).toBe("default")

    const opts3 = await resolveSendOptions({
      appSettings: { permissionMode: "acceptEdits" } as AppSettings,
    })
    expect(opts3.permissionMode).toBe("acceptEdits")

    const opts4 = await resolveSendOptions({})
    expect(opts4.permissionMode).toBeUndefined()
  })
})

describe("resolveSendOptions — activeProject (workspace)", () => {
  it("primary root sits between session override and character default", async () => {
    // session override wins over workspace
    const opts1 = await resolveSendOptions({
      session: makeSession({ id: "s1", workingDir: "/sess-dir" }),
      activeProject: makeProject([{ path: "/ws-dir", isPrimary: true }]),
      character: makeChar({ workingDir: "/char-dir" }),
    })
    expect(opts1.cwd).toBe("/sess-dir")

    // workspace wins over character + app when no session override
    const opts2 = await resolveSendOptions({
      activeProject: makeProject([{ path: "/ws-dir", isPrimary: true }]),
      character: makeChar({ workingDir: "/char-dir" }),
      appSettings: { defaultWorkingDir: "/app-dir" } as AppSettings,
    })
    expect(opts2.cwd).toBe("/ws-dir")

    // falls through to character when the workspace has no roots
    const opts3 = await resolveSendOptions({
      activeProject: makeProject([]),
      character: makeChar({ workingDir: "/char-dir" }),
    })
    expect(opts3.cwd).toBe("/char-dir")
  })

  it("uses the flagged primary root (not just the first) as cwd", async () => {
    const opts = await resolveSendOptions({
      activeProject: makeProject([{ path: "/first" }, { path: "/primary", isPrimary: true }]),
    })
    expect(opts.cwd).toBe("/primary")
  })

  it("unions non-primary roots with referencedPaths and dedupes", async () => {
    const opts = await resolveSendOptions({
      activeProject: makeProject([
        { path: "/ws", isPrimary: true },
        { path: "/extra/a" },
        { path: "/extra/b" },
      ]),
      referencedPaths: [
        { absolute: "/extra/a", isDir: true }, // dup of an additional root
        { absolute: "/Users/me/folder/file.ts", isDir: false },
      ],
    })
    expect(opts.additionalDirectories?.sort()).toEqual(
      ["/extra/a", "/extra/b", "/Users/me/folder"].sort()
    )
  })

  it("adds non-primary roots even when there are no referencedPaths", async () => {
    const opts = await resolveSendOptions({
      activeProject: makeProject([{ path: "/ws", isPrimary: true }, { path: "/only/extra" }]),
    })
    expect(opts.additionalDirectories).toEqual(["/only/extra"])
  })
})

describe("resolveSendOptions — workspace Restricted Mode", () => {
  it("unions RESTRICTED_MODE_DENIED_TOOLS into disallowedTools when restricted", async () => {
    const opts = await resolveSendOptions({
      activeProject: makeProject([{ path: "/a", isPrimary: true }]),
      workspaceRestricted: true,
    })
    expect(opts.disallowedTools).toEqual(expect.arrayContaining(["Bash", "Edit", "Write"]))
  })

  it("does not deny side-effecting tools when not restricted", async () => {
    const opts = await resolveSendOptions({
      activeProject: makeProject([{ path: "/a", isPrimary: true }]),
      workspaceRestricted: false,
    })
    expect(opts.disallowedTools ?? []).not.toContain("Bash")
  })

  it("strips computer-use plugin tools from the allow list when restricted", async () => {
    const ch = makeChar({ allowedTools: ["mcp__cognia-plugin-tools__computer_use", "Read"] })
    const opts = await resolveSendOptions({
      character: ch,
      activeProject: makeProject([{ path: "/a", isPrimary: true }]),
      workspaceRestricted: true,
    })
    expect(opts.allowedTools ?? []).not.toContain("mcp__cognia-plugin-tools__computer_use")
    expect(opts.disallowedTools).toEqual(
      expect.arrayContaining(["mcp__cognia-plugin-tools__computer_use"])
    )
  })
})

describe("resolveSendOptions — MCP subset", () => {
  it("memberOverride.mcpServerIdsOverride filters the enabled list", async () => {
    mListMcp.mockResolvedValue([
      { id: "a", name: "a" },
      { id: "b", name: "b" },
      { id: "c", name: "c" },
    ])
    mBuildMap.mockReturnValueOnce({ a: { command: "a" } })
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      memberOverride: { characterId: "c1", mcpServerIdsOverride: ["a"] },
    })
    expect(opts.mcpServers).toEqual({ a: { command: "a" } })
    expect(mBuildMap).toHaveBeenCalledWith([{ id: "a", name: "a" }])
  })

  it("character.mcpServerIds is honoured when no member override is given", async () => {
    mListMcp.mockResolvedValue([
      { id: "a", name: "a" },
      { id: "b", name: "b" },
    ])
    mBuildMap.mockReturnValueOnce({ b: { command: "b" } })
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", mcpServerIds: ["b"] }),
    })
    expect(opts.mcpServers).toEqual({ b: { command: "b" } })
  })

  it("falls back to team.mcpServerIds for team sessions", async () => {
    mListMcp.mockResolvedValue([
      { id: "a", name: "a" },
      { id: "b", name: "b" },
    ])
    mBuildMap.mockReturnValueOnce({ a: { command: "a" } })
    mGetTeam.mockResolvedValueOnce({ id: "t1", mcpServerIds: ["a"] } as Team)
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", kind: "team", teamId: "t1" }),
    })
    expect(opts.mcpServers).toEqual({ a: { command: "a" } })
  })

  it("falls back to all enabled servers when no narrowing applies", async () => {
    mListMcp.mockResolvedValue([{ id: "a", name: "a" }])
    mBuildMap.mockReturnValueOnce({ a: { command: "a" } })
    const opts = await resolveSendOptions({})
    expect(opts.mcpServers).toEqual({ a: { command: "a" } })
  })

  it("omits mcpServers when no servers match", async () => {
    mListMcp.mockResolvedValue([{ id: "a", name: "a" }])
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", mcpServerIds: ["does-not-exist"] }),
    })
    expect(opts.mcpServers).toBeUndefined()
  })

  it("non-fatal: a Dexie error during the MCP step doesn't block the send", async () => {
    mListMcp.mockRejectedValueOnce(new Error("DB offline"))
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
    const opts = await resolveSendOptions({})
    expect(opts.mcpServers).toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("skips team lookup when session is direct (kind != team)", async () => {
    mListMcp.mockResolvedValue([{ id: "a", name: "a" }])
    mBuildMap.mockReturnValueOnce({ a: { command: "a" } })
    await resolveSendOptions({ session: makeSession({ id: "s1", kind: "direct" }) })
    expect(mGetTeam).not.toHaveBeenCalled()
  })

  it("ignores team without mcpServerIds (falls back to all enabled)", async () => {
    mListMcp.mockResolvedValue([{ id: "a", name: "a" }])
    mBuildMap.mockReturnValueOnce({ a: { command: "a" } })
    mGetTeam.mockResolvedValueOnce({ id: "t1" } as Team) // no mcpServerIds
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", kind: "team", teamId: "t1" }),
    })
    expect(opts.mcpServers).toEqual({ a: { command: "a" } })
  })
})

describe("resolveSendOptions — resume", () => {
  it("attaches resumeSessionId when sdkSessionId is set and not forked", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", sdkSessionId: "sdk-1" }),
    })
    expect(opts.resumeSessionId).toBe("sdk-1")
  })

  it("populates forkFromSessionId (not resumeSessionId) when the session is forked", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({
        id: "s1",
        sdkSessionId: "sdk-1",
        forkedFromSdkSessionId: "sdk-0",
      }),
    })
    // Forking takes precedence: the dispatcher uses forkFromSessionId both as
    // the resume target AND as the "isFork" flag, so we must NOT also set
    // resumeSessionId (mutually exclusive in the SDK).
    expect(opts.resumeSessionId).toBeUndefined()
    expect(opts.forkFromSessionId).toBe("sdk-0")
  })

  it("omits resumeSessionId when no sdkSessionId is set", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
    })
    expect(opts.resumeSessionId).toBeUndefined()
    expect(opts.forkFromSessionId).toBeUndefined()
  })
})

describe("resolveSendOptions — bare mode", () => {
  it("translates bareMode to settingSources [] + strictMcpConfig true", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", bareMode: true }),
    })
    expect(opts.settingSources).toEqual([])
    expect(opts.strictMcpConfig).toBe(true)
  })

  it("does nothing when bareMode is false / unset at every level", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar(),
      appSettings: { id: "singleton" } as AppSettings,
    })
    expect(opts.settingSources).toBeUndefined()
    expect(opts.strictMcpConfig).toBeUndefined()
  })

  it("session.bareMode wins over character + app default", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", bareMode: false }),
      character: makeChar({ bareMode: true }),
      appSettings: { id: "singleton", bareMode: true } as AppSettings,
    })
    expect(opts.settingSources).toBeUndefined()
  })

  it("character.bareMode beats app default", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar({ bareMode: true }),
      appSettings: { id: "singleton", bareMode: false } as AppSettings,
    })
    expect(opts.settingSources).toEqual([])
    expect(opts.strictMcpConfig).toBe(true)
  })

  it("appSettings.bareMode applies when nothing closer is set", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar(),
      appSettings: { id: "singleton", bareMode: true } as AppSettings,
    })
    expect(opts.settingSources).toEqual([])
    expect(opts.strictMcpConfig).toBe(true)
  })
})

describe("resolveSendOptions — debug mode", () => {
  it("populates env.DEBUG and env.CLAUDE_CODE_DEBUG when debugMode is on", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", debugMode: true }),
    })
    expect(opts.env?.DEBUG).toBe("*")
    expect(opts.env?.CLAUDE_CODE_DEBUG).toBe("1")
  })

  it("leaves env unset when debugMode is off everywhere", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
    })
    expect(opts.env).toBeUndefined()
  })

  it("character.debugMode applies when no session override", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar({ debugMode: true }),
    })
    expect(opts.env?.DEBUG).toBe("*")
  })

  it("session.debugMode === false beats character + app default", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", debugMode: false }),
      character: makeChar({ debugMode: true }),
      appSettings: { id: "singleton", debugMode: true } as AppSettings,
    })
    expect(opts.env).toBeUndefined()
  })
})

describe("resolveSendOptions — brief mode", () => {
  it("appends BRIEF_OUTPUT_SNIPPET to appendSystemPrompt when set", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", briefMode: true }),
    })
    expect(opts.appendSystemPrompt).toContain("Respond concisely")
  })

  it("merges with an existing appendSystemPrompt (e.g., A2UI block) under a blank line", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", briefMode: true, a2uiEnabled: true } as ChatSession & {
        a2uiEnabled?: boolean
      }),
      character: makeChar({ a2uiEnabled: true }),
    })
    expect(opts.appendSystemPrompt).toMatch(/A2UI[\s\S]+\n\nRespond concisely/i)
  })

  it("omits the snippet when briefMode is off", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
    })
    expect(opts.appendSystemPrompt ?? "").not.toContain("Respond concisely")
  })

  it("character.briefMode applies in absence of session override", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar({ briefMode: true }),
    })
    expect(opts.appendSystemPrompt).toContain("Respond concisely")
  })

  it("appSettings.briefMode applies when nothing closer set", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar(),
      appSettings: { id: "singleton", briefMode: true } as AppSettings,
    })
    expect(opts.appendSystemPrompt).toContain("Respond concisely")
  })
})

describe("resolveSendOptions — extended thinking budget", () => {
  it("session > character > appSettings — session wins when all three set", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", maxThinkingTokens: 8000 }),
      character: makeChar({ maxThinkingTokens: 4000 }),
      appSettings: { id: "singleton", defaultMaxThinkingTokens: 2000 } as AppSettings,
    })
    expect(opts.maxThinkingTokens).toBe(8000)
  })

  it("falls through to character when session is unset", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar({ maxThinkingTokens: 4000 }),
      appSettings: { id: "singleton", defaultMaxThinkingTokens: 2000 } as AppSettings,
    })
    expect(opts.maxThinkingTokens).toBe(4000)
  })

  it("falls through to appSettings when session and character are unset", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar(),
      appSettings: { id: "singleton", defaultMaxThinkingTokens: 2000 } as AppSettings,
    })
    expect(opts.maxThinkingTokens).toBe(2000)
  })

  it("omits the field entirely when budget is 0 (= use SDK default)", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", maxThinkingTokens: 0 }),
      character: makeChar({ maxThinkingTokens: 0 }),
      appSettings: { id: "singleton", defaultMaxThinkingTokens: 0 } as AppSettings,
    })
    expect(opts.maxThinkingTokens).toBeUndefined()
  })

  it("omits the field when nothing is configured", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar(),
      appSettings: { id: "singleton" } as AppSettings,
    })
    expect(opts.maxThinkingTokens).toBeUndefined()
  })
})

describe("listTeamMembers", () => {
  it("delegates to listCharactersByIds", async () => {
    mListCharsByIds.mockResolvedValueOnce([makeChar({ id: "c1" })])
    const out = await listTeamMembers(["c1"])
    expect(mListCharsByIds).toHaveBeenCalledWith(["c1"])
    expect(out).toHaveLength(1)
  })
})

describe("resolveSendOptions — Computer Use plugin-tool gating", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sidecarBridge = require("@/lib/plugin/bridge/sidecar-tools-bridge")
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const overrides = require("@/lib/db/conversation-overrides")
  const mBuildManifest = sidecarBridge.buildPluginToolsManifest as jest.Mock
  const mReadOverride = overrides.readForResolution as jest.Mock

  const cuTools = [
    {
      name: "computer_use",
      description: "drive desktop",
      jsonSchema: {},
      pluginId: "cognia-computer-use",
    },
    {
      name: "bash",
      description: "shell",
      jsonSchema: {},
      pluginId: "cognia-computer-use",
    },
    {
      name: "text_editor",
      description: "edit",
      jsonSchema: {},
      pluginId: "cognia-computer-use",
    },
  ]
  const otherTool = {
    name: "github_pr",
    description: "open a PR",
    jsonSchema: {},
    pluginId: "cognia-github-delivery",
  }

  beforeEach(() => {
    mBuildManifest.mockReset().mockReturnValue([...cuTools, otherTool])
    mReadOverride.mockReset()
  })

  it("includes computer-use plugin tools when character.enableComputerUse=true", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar({ enableComputerUse: true }),
    })
    const names = (opts.pluginTools ?? []).map((t) => t.name).sort()
    expect(names).toEqual(["bash", "computer_use", "github_pr", "text_editor"])
  })

  it("filters computer-use plugin tools when character.enableComputerUse !== true", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar({ enableComputerUse: false }),
    })
    const names = (opts.pluginTools ?? []).map((t) => t.name)
    expect(names).toEqual(["github_pr"])
    expect(names).not.toContain("computer_use")
  })

  it("filters when character has no Computer Use flag at all", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar(),
    })
    const names = (opts.pluginTools ?? []).map((t) => t.name)
    expect(names).toEqual(["github_pr"])
  })

  it("IM-session default-denies computer-use plugin tools even when character allows", async () => {
    mReadOverride.mockResolvedValueOnce(undefined)
    const opts = await resolveSendOptions({
      session: makeSession({
        id: "s1",
        platformBinding: {
          adapterId: "telegram",
          conversationKey: "tg:123",
        },
      } as ChatSession),
      character: makeChar({ enableComputerUse: true }),
    })
    const names = (opts.pluginTools ?? []).map((t) => t.name)
    expect(names).toEqual(["github_pr"])
  })

  it("IM-session opt-in (allowComputerUse=true) restores computer-use plugin tools", async () => {
    mReadOverride.mockResolvedValueOnce({ allowComputerUse: true })
    const opts = await resolveSendOptions({
      session: makeSession({
        id: "s1",
        platformBinding: {
          adapterId: "telegram",
          conversationKey: "tg:123",
        },
      } as ChatSession),
      character: makeChar({ enableComputerUse: true }),
    })
    const names = (opts.pluginTools ?? []).map((t) => t.name).sort()
    expect(names).toEqual(["bash", "computer_use", "github_pr", "text_editor"])
  })

  it("disablePluginTools wipes the manifest regardless of Computer Use", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar({ enableComputerUse: true, disablePluginTools: true }),
    })
    expect(opts.pluginTools).toBeUndefined()
  })
})

describe("resolveSendOptions — workflow-editor (Workflow Copilot mode)", () => {
  it("REPLACES the system prompt with the Workflow Copilot prompt", async () => {
    const ch = makeChar({
      id: "c1",
      systemPrompt: "I am Marketing Assistant — perky and witty.",
    })
    const opts = await resolveSendOptions({
      character: ch,
      session: makeSession({ id: "workflow:wf_42", kind: "workflow-editor" }),
    })
    // The character prompt is gone.
    expect(opts.systemPrompt).not.toContain("Marketing Assistant")
    // The Workflow Copilot identity is in.
    expect(opts.systemPrompt).toContain("Workflow Copilot")
    expect(opts.systemPrompt).toContain("wf_propose_batch")
  })

  it("overrides allowedTools with the strict whitelist (no Bash, no Edit, no Write)", async () => {
    const ch = makeChar({
      id: "c1",
      // Try to sneak Bash in via the character — Workflow Copilot must
      // ignore it.
      allowedTools: ["Bash", "Edit", "Write"],
    })
    const opts = await resolveSendOptions({
      character: ch,
      session: makeSession({ id: "workflow:wf_42", kind: "workflow-editor" }),
    })
    expect(opts.allowedTools).toBeDefined()
    expect(opts.allowedTools).not.toContain("Bash")
    expect(opts.allowedTools).not.toContain("Edit")
    expect(opts.allowedTools).not.toContain("Write")
    // The wf_* family must be in.
    expect(opts.allowedTools).toContain("mcp__cognia-plugin-tools__wf_read_graph")
    expect(opts.allowedTools).toContain("mcp__cognia-plugin-tools__wf_propose_batch")
    expect(opts.allowedTools).toContain("mcp__cognia-plugin-tools__wf_apply_template")
  })

  it("sets a defense-in-depth disallowedTools list that includes Bash + Computer Use", async () => {
    const ch = makeChar({ id: "c1" })
    const opts = await resolveSendOptions({
      character: ch,
      session: makeSession({ id: "workflow:wf_42", kind: "workflow-editor" }),
    })
    expect(opts.disallowedTools).toBeDefined()
    expect(opts.disallowedTools).toContain("Bash")
    expect(opts.disallowedTools).toContain("Write")
    expect(opts.disallowedTools).toContain("Edit")
    // Computer Use names
    expect(opts.disallowedTools).toContain("computer")
    expect(opts.disallowedTools).toContain("str_replace_editor")
  })

  it("drops mcpServers (external MCP) — Workflow Copilot only uses the synthetic plugin-tools server", async () => {
    mListMcp.mockResolvedValueOnce([
      { id: "test-runner", name: "Test Runner" } as unknown as Awaited<
        ReturnType<typeof listEnabledMcpServers>
      >[number],
    ])
    mBuildMap.mockReturnValueOnce({ "test-runner": { command: "x", args: [] } })
    const ch = makeChar({ id: "c1" })
    const opts = await resolveSendOptions({
      character: ch,
      session: makeSession({ id: "workflow:wf_42", kind: "workflow-editor" }),
    })
    expect(opts.mcpServers).toBeUndefined()
  })

  it("scopes Read to lib/workflow/copilot-templates via additionalDirectories", async () => {
    const ch = makeChar({ id: "c1" })
    const opts = await resolveSendOptions({
      character: ch,
      session: makeSession({ id: "workflow:wf_42", kind: "workflow-editor" }),
    })
    expect(opts.additionalDirectories).toEqual(["lib/workflow/copilot-templates"])
  })

  it("clears appendSystemPrompt — A2UI / skill / goal sections do not leak into this session", async () => {
    const ch = makeChar({
      id: "c1",
      // briefMode would normally add to appendSystemPrompt
      briefMode: true,
    })
    const opts = await resolveSendOptions({
      character: ch,
      session: makeSession({ id: "workflow:wf_42", kind: "workflow-editor" }),
    })
    // appendSystemPrompt is either undefined (no editor open) or only the
    // workflow snapshot block — definitely NOT BRIEF_OUTPUT_SNIPPET text.
    if (opts.appendSystemPrompt) {
      // It can only contain the workflow snapshot block, never the brief snippet.
      expect(opts.appendSystemPrompt).not.toContain("Keep responses")
    }
  })

  it("attaches the four workflow subagents", async () => {
    const ch = makeChar({ id: "c1" })
    const opts = await resolveSendOptions({
      character: ch,
      session: makeSession({ id: "workflow:wf_42", kind: "workflow-editor" }),
    })
    expect(opts.agents).toBeDefined()
    expect(opts.agents).toHaveProperty("workflow-designer")
    expect(opts.agents).toHaveProperty("workflow-debugger")
    expect(opts.agents).toHaveProperty("workflow-refactorer")
    expect(opts.agents).toHaveProperty("workflow-doc-writer")
  })

  it("STILL applies the resume/fork continuity logic below the override block", async () => {
    const ch = makeChar({ id: "c1" })
    const opts = await resolveSendOptions({
      character: ch,
      session: makeSession({
        id: "workflow:wf_42",
        kind: "workflow-editor",
        sdkSessionId: "sdk_42",
      } as Partial<ChatSession>),
    })
    // The post-branch code at lines 912+ sets opts.resumeSessionId when
    // the session has an sdkSessionId. Workflow-editor override must NOT
    // clobber this.
    expect(opts.resumeSessionId).toBe("sdk_42")
  })

  it("does NOT touch other session kinds", async () => {
    const ch = makeChar({
      id: "c1",
      systemPrompt: "I am Marketing Assistant.",
      allowedTools: ["Bash"],
    })
    const opts = await resolveSendOptions({
      character: ch,
      session: makeSession({ id: "s_direct", kind: "direct" }),
    })
    // Normal session: Workflow Copilot prompt should NOT be installed.
    expect(opts.systemPrompt).toContain("Marketing Assistant")
    expect(opts.systemPrompt).not.toContain("Workflow Copilot")
    // Character's allowedTools survives.
    expect(opts.allowedTools).toContain("Bash")
  })
})

describe("resolveSendOptions — ADR-0028 sandbox builtin replacement", () => {
  it("disallows SDK Bash/Edit/Write + filters text_editor when session sandbox is enabled", async () => {
    mGetCharacter.mockResolvedValue(
      makeChar({
        id: "c1",
        enableComputerUse: true,
      })
    )
    const opts = await resolveSendOptions({
      session: makeSession({
        id: "s1",
        characterId: "c1",
        sandboxEnabled: true,
      }),
    })
    const disallowed = opts.disallowedTools ?? []
    expect(disallowed).toContain("Bash")
    expect(disallowed).toContain("Edit")
    expect(disallowed).toContain("Write")
    // text_editor must NOT survive on anthropicTools when sandbox is on.
    if (Array.isArray(opts.anthropicTools)) {
      expect(opts.anthropicTools.map((t) => t.name)).not.toContain("text_editor")
      expect(opts.anthropicTools.map((t) => t.name)).not.toContain("str_replace_based_edit_tool")
    }
    // System prompt hint mentions sandbox_bash / sandbox_edit.
    expect(opts.appendSystemPrompt ?? "").toContain("sandbox_bash")
  })

  it("character.sandboxEnabled wins when session-level is unset", async () => {
    mGetCharacter.mockResolvedValue(makeChar({ id: "c1", sandboxEnabled: true }))
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", characterId: "c1" }),
    })
    expect(opts.disallowedTools ?? []).toContain("Bash")
  })

  it("session.sandboxEnabled = false overrides character + app default", async () => {
    mGetCharacter.mockResolvedValue(makeChar({ id: "c1", sandboxEnabled: true }))
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", characterId: "c1", sandboxEnabled: false }),
      appSettings: {
        id: "singleton",
        alwaysAllowTools: [],
        builtinTools: {
          fileExtras: true,
          git: true,
          process: false,
          environment: true,
          shellAdvanced: false,
        },
        sandboxDefaultEnabled: true,
      } as AppSettings,
    })
    expect(opts.disallowedTools ?? []).not.toContain("Bash")
  })

  it("leaves disallowedTools alone when sandbox is unset on every layer", async () => {
    mGetCharacter.mockResolvedValue(makeChar({ id: "c1" }))
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", characterId: "c1" }),
    })
    expect(opts.disallowedTools ?? []).not.toContain("Bash")
  })
})

describe("resolveSendOptions — ADR-0028 per-`query()` env injection", () => {
  it("merges account env + proxy env into opts.env when accountId resolves", async () => {
    mGetCharacter.mockResolvedValue(makeChar({ id: "c1", providerId: "anthropic" }))
    mResolveAccountId.mockReturnValue("acct-A")
    mResolveAccountEnv.mockResolvedValue({
      CLAUDE_CODE_OAUTH_TOKEN: "oat-A",
      CLAUDE_CONFIG_DIR: "/tmp/configs/acct-A",
      ANTHROPIC_BASE_URL: "https://example.com",
    })
    mResolveProxyEnv.mockResolvedValue({
      HTTPS_PROXY: "http://proxy:8080",
    })

    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", characterId: "c1", accountId: "acct-A" }),
    })

    expect(mResolveAccountId).toHaveBeenCalled()
    expect(mResolveAccountEnv).toHaveBeenCalledWith("anthropic", "acct-A")
    expect(mResolveProxyEnv).toHaveBeenCalledWith("s1")
    expect(opts.env).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: "oat-A",
      CLAUDE_CONFIG_DIR: "/tmp/configs/acct-A",
      ANTHROPIC_BASE_URL: "https://example.com",
      HTTPS_PROXY: "http://proxy:8080",
    })
  })

  it("leaves opts.env unset when no accountId resolves and proxy is inactive", async () => {
    mGetCharacter.mockResolvedValue(makeChar({ id: "c1" }))
    mResolveAccountId.mockReturnValue(null)
    mResolveAccountEnv.mockResolvedValue({})
    mResolveProxyEnv.mockResolvedValue({})

    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", characterId: "c1" }),
    })

    // Either undefined or — if some other layer set DEBUG/CLAUDE_CODE_DEBUG —
    // the account/proxy keys at least must not appear.
    expect(opts.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(opts.env?.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(opts.env?.HTTPS_PROXY).toBeUndefined()
  })

  it("debugMode flags layer on top of account env without colliding", async () => {
    mGetCharacter.mockResolvedValue(makeChar({ id: "c1", providerId: "anthropic" }))
    mResolveAccountId.mockReturnValue("acct-A")
    mResolveAccountEnv.mockResolvedValue({
      CLAUDE_CODE_OAUTH_TOKEN: "oat-A",
    })
    mResolveProxyEnv.mockResolvedValue({})

    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", characterId: "c1", debugMode: true, accountId: "acct-A" }),
    })

    // Account-env keys survive; debugMode keys layer in on top.
    expect(opts.env).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: "oat-A",
      DEBUG: "*",
      CLAUDE_CODE_DEBUG: "1",
    })
  })

  it("proxy fields apply even when no account override is set", async () => {
    mGetCharacter.mockResolvedValue(makeChar({ id: "c1" }))
    mResolveAccountId.mockReturnValue(null)
    mResolveAccountEnv.mockResolvedValue({}) // no accountId resolved
    mResolveProxyEnv.mockResolvedValue({
      HTTPS_PROXY: "http://proxy:8080",
      HTTP_PROXY: "http://proxy:8080",
    })

    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", characterId: "c1" }),
    })

    expect(opts.env).toMatchObject({
      HTTPS_PROXY: "http://proxy:8080",
      HTTP_PROXY: "http://proxy:8080",
    })
    expect(opts.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })
})

describe("resolveSendOptions — tool/MCP filter overlay", () => {
  beforeEach(() => {
    // Reflect the chosen servers so we can assert on the filtered subset.
    mBuildMap.mockImplementation((servers: Array<{ name: string }>) =>
      Object.fromEntries(servers.map((s) => [s.name, {}]))
    )
  })

  it("allow mode intersects the resolved allowedTools", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({
        id: "c1",
        allowedTools: ["a", "b", "c"],
        toolFilter: { mode: "allow", tools: ["b", "c"] },
      }),
    })
    expect(new Set(opts.allowedTools)).toEqual(new Set(["b", "c"]))
  })

  it("deny mode unions filtered tools into disallowedTools and leaves allow alone", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({
        id: "c1",
        allowedTools: ["a", "b"],
        disallowedTools: ["x"],
        toolFilter: { mode: "deny", tools: ["b"] },
      }),
    })
    expect(new Set(opts.disallowedTools)).toEqual(new Set(["x", "b"]))
    expect(new Set(opts.allowedTools)).toEqual(new Set(["a", "b"]))
  })

  it("session filter replaces the character filter", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({
        id: "c1",
        allowedTools: ["a", "b", "c"],
        toolFilter: { mode: "allow", tools: ["a"] },
      }),
      session: makeSession({ id: "s1", toolFilter: { mode: "allow", tools: ["c"] } }),
    })
    expect(new Set(opts.allowedTools)).toEqual(new Set(["c"]))
  })

  it("mode 'all' is a no-op", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({
        id: "c1",
        allowedTools: ["a", "b"],
        toolFilter: { mode: "all", tools: ["b"] },
      }),
    })
    expect(new Set(opts.allowedTools)).toEqual(new Set(["a", "b"]))
  })

  it("allow mode filters the MCP server subset to listed ids", async () => {
    mListMcp.mockResolvedValueOnce([
      { id: "m1", name: "one", transport: "stdio", enabled: true },
      { id: "m2", name: "two", transport: "http", enabled: true },
    ])
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", toolFilter: { mode: "allow", mcpServerIds: ["m1"] } }),
    })
    expect(Object.keys(opts.mcpServers ?? {})).toEqual(["one"])
  })

  it("deny mode drops the listed MCP server ids", async () => {
    mListMcp.mockResolvedValueOnce([
      { id: "m1", name: "one", transport: "stdio", enabled: true },
      { id: "m2", name: "two", transport: "http", enabled: true },
    ])
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", toolFilter: { mode: "deny", mcpServerIds: ["m1"] } }),
    })
    expect(Object.keys(opts.mcpServers ?? {})).toEqual(["two"])
  })
})

describe("resolveSendOptions — runtime tool-search policy", () => {
  it("emits toolSearchEnabled + always-load lists when enabled globally", async () => {
    const opts = await resolveSendOptions({
      appSettings: {
        id: "singleton",
        toolSearchRuntime: {
          enabled: true,
          alwaysLoadServers: ["cognia-tools"],
          alwaysLoadTools: ["git_status"],
        },
      } as unknown as AppSettings,
    })
    expect(opts.toolSearchEnabled).toBe(true)
    expect(opts.alwaysLoadServers).toEqual(["cognia-tools"])
    expect(opts.alwaysLoadTools).toEqual(["git_status"])
  })

  it("character override replaces the global runtime policy", async () => {
    const opts = await resolveSendOptions({
      appSettings: {
        id: "singleton",
        toolSearchRuntime: { enabled: true, alwaysLoadServers: ["global"] },
      } as unknown as AppSettings,
      character: makeChar({
        id: "c1",
        toolSearchRuntimeOverride: { enabled: true, alwaysLoadServers: ["char"] },
      }),
    })
    expect(opts.alwaysLoadServers).toEqual(["char"])
  })

  it("leaves toolSearchEnabled unset when disabled", async () => {
    const opts = await resolveSendOptions({ character: makeChar({ id: "c1" }) })
    expect(opts.toolSearchEnabled).toBeUndefined()
  })
})

describe("resolveSendOptions — unified LSP (sendOptions.lsp)", () => {
  it("resolves builtin + user layers onto opts.lsp when enabled with a cwd", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", workingDir: "/proj" }),
      appSettings: {
        lsp: {
          enabled: true,
          servers: [{ id: "lsp_custom", name: "Lua", languages: ["lua"], command: "lua-ls" }],
        },
      } as AppSettings,
    })
    expect(opts.lsp?.enabled).toBe(true)
    const ids = (opts.lsp?.servers ?? []).map((srv) => srv.id)
    expect(ids).toContain("typescript")
    expect(ids).toContain("lsp_custom")
    // jsdom is not Tauri — the managed install dir stays unset.
    expect(opts.lsp?.installDir).toBeUndefined()
    expect(opts.lsp?.autoInstall).toBe(true)
  })

  it("falls back to the legacy builtinTools.lsp toggle when settings.lsp.enabled is unset", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", workingDir: "/proj" }),
      appSettings: { builtinTools: { lsp: true } } as AppSettings,
    })
    expect(opts.lsp?.enabled).toBe(true)
  })

  it("omits opts.lsp without a cwd", async () => {
    const opts = await resolveSendOptions({
      appSettings: { lsp: { enabled: true, servers: [] } } as unknown as AppSettings,
    })
    expect(opts.lsp).toBeUndefined()
  })

  it("omits opts.lsp when the master toggle is off", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", workingDir: "/proj" }),
      appSettings: { lsp: { enabled: false, servers: [] } } as unknown as AppSettings,
    })
    expect(opts.lsp).toBeUndefined()
  })

  it("propagates autoInstall: false", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", workingDir: "/proj" }),
      appSettings: {
        lsp: { enabled: true, servers: [], autoInstall: false },
      } as unknown as AppSettings,
    })
    expect(opts.lsp?.autoInstall).toBe(false)
  })
})
