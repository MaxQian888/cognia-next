import type { ChatSession } from "@cognia/agent-config-types"
import {
  inheritableSessionConfig,
  missingInheritedSessionConfig,
} from "./session-config-inheritance"

const parent: ChatSession = {
  id: "main",
  title: "Main",
  createdAt: 1,
  updatedAt: 1,
  model: "claude",
  providerOverride: "anthropic",
  accountId: "account",
  characterId: "character",
  teamId: "team",
  squadId: "squad",
  externalAgentModels: { codex: { kind: "native", modelId: "model" } },
  sandboxEnabled: true,
  sandboxTier: "microvm",
  sandboxTierFollowsDefault: false,
  computerUseTarget: "local",
  workingDir: "/work",
  permissionMode: "acceptEdits",
  systemPrompt: "Instructions",
  activePresetId: "preset",
  disabledSkillIds: ["skill"],
  toolFilter: { mode: "allow", tools: ["Read"] },
  maxThinkingTokens: 1000,
  outputStyle: "custom",
  customOutputStyle: "Concise",
  bareMode: false,
  debugMode: true,
  briefMode: true,
  messageDisplayOverride: { preset: "inspector" },
  sdkSessionId: "sdk",
  branchSeed: { kind: "transcript", content: "History" },
} as ChatSession

it("inherits all branch configuration while leaving thread state and identity behind", () => {
  const config = inheritableSessionConfig(parent)
  const expected: Partial<ChatSession> = { ...parent }
  for (const key of [
    "id",
    "title",
    "createdAt",
    "updatedAt",
    "sdkSessionId",
    "branchSeed",
  ] as const) {
    delete expected[key]
  }
  expect(config).toEqual(expected)
  expect(config).not.toHaveProperty("sdkSessionId")
  expect(config).not.toHaveProperty("branchSeed")
})

it("asides inherit the same configuration without launching a team or squad", () => {
  const config = inheritableSessionConfig(parent, "aside")
  const branch = inheritableSessionConfig(parent)
  delete branch.teamId
  delete branch.squadId
  expect(config).toEqual(branch)
  expect(config).not.toHaveProperty("teamId")
  expect(config).not.toHaveProperty("squadId")
  expect(config.characterId).toBe("character")
})

it("only fills undefined aside fields, preserving false values and empty choices", () => {
  const existing = {
    ...parent,
    model: "chosen",
    sandboxEnabled: false,
    disabledSkillIds: [],
    systemPrompt: "",
    accountId: undefined,
  } as ChatSession
  expect(missingInheritedSessionConfig(existing, parent)).toEqual({ accountId: "account" })
  expect(missingInheritedSessionConfig(existing, { ...parent, accountId: undefined })).toEqual({})
})
