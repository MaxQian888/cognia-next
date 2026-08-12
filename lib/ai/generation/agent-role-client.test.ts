import type { AppSettings, Character, ChatSession } from "@cognia/agent-config-types"

const resolveCharacterById = jest.fn<Promise<Character | undefined>, [id: string]>(
  async () => undefined
)
const buildUtilityLlmClient = jest.fn((_args: unknown) => ({ complete: jest.fn() }))

jest.mock("@/lib/db/characters", () => ({
  resolveCharacterById: (id: string) => resolveCharacterById(id),
}))
jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: (args: unknown) => buildUtilityLlmClient(args),
}))

import { buildAgentRoleLlmClient } from "./agent-role-client"

beforeEach(() => jest.clearAllMocks())

function character(overrides: Partial<Character> = {}): Character {
  return {
    id: "agent-1",
    name: "Agent",
    avatarColor: "oklch(0.7 0.15 240)",
    systemPrompt: "Help the user.",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

it("uses the bound Agent planning target and provider", async () => {
  resolveCharacterById.mockResolvedValue(
    character({
      providerId: "openai",
      modelRouting: { plan: "planner-alias" },
    })
  )
  const session = { id: "session-1", characterId: "agent-1" } as ChatSession

  await buildAgentRoleLlmClient({
    role: "plan",
    session,
    appSettings: { defaultModel: "app-model" } as AppSettings,
    featureId: "plan-decompose",
  })

  expect(buildUtilityLlmClient).toHaveBeenCalledWith(
    expect.objectContaining({
      session,
      override: { providerOverride: "openai", model: "planner-alias" },
    })
  )
})

it("keeps a feature override above the Agent target", async () => {
  resolveCharacterById.mockResolvedValue(
    character({
      providerId: "openai",
      modelRouting: { plan: "planner-alias" },
    })
  )

  await buildAgentRoleLlmClient({
    role: "plan",
    session: { id: "session-1", characterId: "agent-1" } as ChatSession,
    appSettings: {} as AppSettings,
    override: { providerOverride: "anthropic", model: "feature-model" },
    featureId: "plan-refine",
  })

  expect(buildUtilityLlmClient).toHaveBeenCalledWith(
    expect.objectContaining({
      override: { providerOverride: "anthropic", model: "feature-model" },
    })
  )
})

it("keeps an explicit session model above the Agent semantic target", async () => {
  resolveCharacterById.mockResolvedValue(
    character({
      providerId: "openai",
      modelRouting: { plan: "planner-alias" },
    })
  )

  await buildAgentRoleLlmClient({
    role: "plan",
    session: {
      id: "session-1",
      characterId: "agent-1",
      model: "session-model",
    } as ChatSession,
    appSettings: {} as AppSettings,
    featureId: "plan-refine",
  })

  expect(buildUtilityLlmClient).toHaveBeenCalledWith(
    expect.objectContaining({
      override: { providerOverride: "openai", model: "session-model" },
    })
  )
})

it("retains the existing cheap utility fallback when the Agent has no utility target", async () => {
  resolveCharacterById.mockResolvedValue(character({ providerId: "openai" }))

  await buildAgentRoleLlmClient({
    role: "utility",
    session: { id: "session-1", characterId: "agent-1" } as ChatSession,
    appSettings: { defaultModel: "app-model" } as AppSettings,
    featureId: "title",
  })

  expect(buildUtilityLlmClient).toHaveBeenCalledWith(
    expect.objectContaining({ override: { providerOverride: "openai", model: undefined } })
  )
})
