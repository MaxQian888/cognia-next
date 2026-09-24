/**
 * Lead planning against the REAL `executeAgent` and the REAL provider resolver.
 *
 * Every other `runLeadPlanning` test injects `opts.executeAgent`, which is
 * precisely what hid the defect this file guards: the call site passed no
 * provider inputs, and since `executeAgent` reads no store, resolution built
 * zero candidates and threw `No candidate providers were available.` on every
 * invocation — while a fake executor happily returned a plan.
 *
 * So: `@/lib/ai/provider-consumption` stays real (it is the subject), and only
 * `streamText` — the one thing that would touch the network — is mocked.
 */
import { streamText } from "ai"
import { buildAgentTeamRuntimeDeps } from "./agent-team-runtime-deps"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AppSettings } from "@cognia/agent-config-types"
import type { AgentTeam, AgentTeammate } from "@/types/agent/agent-team"

jest.mock("ai", () => ({ streamText: jest.fn() }))

const mockStreamText = streamText as jest.MockedFunction<typeof streamText>

function mockReply(text: string) {
  mockStreamText.mockReturnValue({
    textStream: (async function* () {
      yield text
    })(),
    finishReason: Promise.resolve("stop"),
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 2 }),
  } as unknown as ReturnType<typeof streamText>)
}

function makeTeam(): AgentTeam {
  return {
    id: "team-1",
    name: "Demo",
    description: "",
    task: "Investigate the topic.",
    status: "idle",
    config: {
      maxTeammates: 5,
      maxConcurrentTeammates: 2,
      executionMode: "coordinated",
      displayMode: "compact",
    },
    leadId: "lead-1",
    teammateIds: ["lead-1", "tm-1"],
    taskIds: [],
    messageIds: [],
    progress: 0,
    totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    createdAt: new Date(),
  }
}

function makeMember(overrides: Partial<AgentTeammate>): AgentTeammate {
  return {
    id: "tm-1",
    teamId: "team-1",
    name: "Researcher",
    description: "research",
    role: "teammate",
    status: "idle",
    config: {},
    completedTaskIds: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    progress: 0,
    createdAt: new Date(),
    ...overrides,
  }
}

const lead = makeMember({ id: "lead-1", name: "Lead", role: "lead" })

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-8",
    providerSettings: {
      anthropic: { enabled: true, apiKey: "sk-ant-test", defaultModel: "claude-opus-4-8" },
    },
    ...overrides,
  } as AppSettings
}

function planWith(appSettings: AppSettings | null) {
  const { runLeadPlanning } = buildAgentTeamRuntimeDeps({ readSettings: async () => appSettings })
  return runLeadPlanning!({
    team: makeTeam(),
    lead,
    feedback: undefined,
    signal: new AbortController().signal,
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  useAgentTeamStore.getState().reset()
  const store = useAgentTeamStore.getState()
  store.upsertTeam(makeTeam())
  store.upsertTeammate(lead)
  store.upsertTeammate(makeMember({}))
  mockReply('```json\n{ "summary": "Plan", "steps": [] }\n```')
})

describe("runLeadPlanning against the real executeAgent", () => {
  it("returns a plan when the app has a provider configured", async () => {
    const out = await planWith(settings())

    expect(out.planText).toContain('"summary": "Plan"')
    expect(mockStreamText).toHaveBeenCalledTimes(1)
  })

  it("runs the lead on an explicitly configured Opus provider/model", async () => {
    const opusLead = makeMember({
      id: "lead-1",
      name: "Lead",
      role: "lead",
      config: { provider: "anthropic", model: "claude-opus-4-8" },
    })
    useAgentTeamStore.getState().upsertTeammate(opusLead)
    const { runLeadPlanning } = buildAgentTeamRuntimeDeps({ readSettings: async () => settings() })

    await runLeadPlanning!({
      team: makeTeam(),
      lead: opusLead,
      feedback: undefined,
      signal: new AbortController().signal,
    })

    // The resolved model id reaches the AI SDK — proving the chain end to end.
    const call = mockStreamText.mock.calls[0]?.[0] as { model: { modelId?: string } }
    expect(call.model.modelId).toBe("claude-opus-4-8")
  })

  it("resolves through a custom provider", async () => {
    const customLead = makeMember({
      id: "lead-1",
      name: "Lead",
      role: "lead",
      config: { provider: "my-gateway" as never },
    })
    await (async () => {
      const { runLeadPlanning } = buildAgentTeamRuntimeDeps({
        readSettings: async () =>
          settings({
            providerSettings: {},
            customProviders: [
              {
                id: "my-gateway",
                name: "My Gateway",
                apiProtocol: "openai",
                baseURL: "https://gateway.example/v1",
                apiKey: "sk-gw",
                defaultModel: "gpt-5.6-sol",
              },
            ] as unknown as AppSettings["customProviders"],
          }),
      })
      await runLeadPlanning!({
        team: makeTeam(),
        lead: customLead,
        feedback: undefined,
        signal: new AbortController().signal,
      })
    })()

    const call = mockStreamText.mock.calls[0]?.[0] as { model: { modelId?: string } }
    expect(call.model.modelId).toBe("gpt-5.6-sol")
  })

  it("fails with an actionable message — not the bare resolver reason — when nothing is configured", async () => {
    await expect(planWith(settings({ providerSettings: {}, customProviders: [] }))).rejects.toThrow(
      /Settings → Providers/
    )
    // The exact string the pre-fix build died with, on every run.
    await expect(
      planWith(settings({ providerSettings: {}, customProviders: [] }))
    ).rejects.not.toThrow(/No candidate providers were available/)
    expect(mockStreamText).not.toHaveBeenCalled()
  })

  it("fails with an actionable message when settings never loaded", async () => {
    await expect(planWith(null)).rejects.toThrow(/Settings → Providers/)
  })
})
