// Mock every database / store / agent-mode dependency so build-options can be
// exercised as a pure function. We never want to touch Dexie or Zustand here.

jest.mock("@/lib/db/characters", () => ({
  getCharacter: jest.fn(),
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

import { buildAgentModeSessionUpdate } from "@/lib/agent"
import { getCharacter, listCharactersByIds } from "@/lib/db/characters"
import { buildMcpServerMap, listEnabledMcpServers } from "@/lib/db/mcp-servers"
import { listEnabledSkillsByIds, recordSkillUsage, renderSkillsSection } from "@/lib/db/skills"
import { getTeam } from "@/lib/db/teams"
import { useAgentRuntimeStore } from "@/stores/agent"
import { useCustomModeStore } from "@/stores/agent/custom-mode-store"
import type { AgentModeConfig } from "@/types/agent/agent-mode"

import { listTeamMembers, resolveMemberConfig, resolveSendOptions } from "./build-options"
import type { AppSettings, Character, ChatSession, Skill, Team, TeamMember } from "./types"

const mGetCharacter = getCharacter as jest.Mock
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

  it("treats undefined character as null when getCharacter resolves undefined", async () => {
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

describe("listTeamMembers", () => {
  it("delegates to listCharactersByIds", async () => {
    mListCharsByIds.mockResolvedValueOnce([makeChar({ id: "c1" })])
    const out = await listTeamMembers(["c1"])
    expect(mListCharsByIds).toHaveBeenCalledWith(["c1"])
    expect(out).toHaveLength(1)
  })
})
