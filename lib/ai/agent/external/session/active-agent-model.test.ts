/** @jest-environment jsdom */
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import { useSettingsStore } from "@/stores/settings"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"
import { activeAgentModelFor, agentModelSelectionInput } from "./active-agent-model"
import type { ExternalAgentModelSurface } from "./session-models"

const surface: ExternalAgentModelSurface = {
  choices: [
    { modelId: "p/a", name: "A", capabilities: { reasoning: false } },
    { modelId: "p/b", name: "B", capabilities: { reasoning: true } },
  ],
  currentModelId: null,
  write: { kind: "session-seed" },
}

beforeEach(() => {
  useExternalAgentStore.setState({ agents: {} })
  useSettingsStore.setState({ settings: {} } as never)
})

describe("agentModelSelectionInput", () => {
  it("reads the agent's own binding only for an agent this client knows", () => {
    expect(agentModelSelectionInput("pi", null)).not.toHaveProperty("agentDefault")
    useExternalAgentStore.setState({
      agents: {
        pi: {
          id: "pi",
          cogniaModel: { providerId: "openai", modelId: "gpt-5" },
        } as ExternalAgentConfig,
      },
    })
    expect(agentModelSelectionInput("pi", null).agentDefault).toEqual({
      providerId: "openai",
      modelId: "gpt-5",
    })
  })
})

describe("activeAgentModelFor", () => {
  it("resolves the conversation's pick against the catalog", () => {
    const active = activeAgentModelFor(
      "pi",
      { externalAgentModels: { pi: { kind: "native", modelId: "p/a" } } },
      surface
    )
    expect(active.modelId).toBe("p/a")
    expect(active.model?.capabilities?.reasoning).toBe(false)
  })

  it("falls back to the app's per-agent default before a conversation exists", () => {
    useSettingsStore.setState({
      settings: { externalAgentModelDefaults: { pi: { kind: "native", modelId: "p/b" } } },
    } as never)
    expect(activeAgentModelFor("pi", null, surface).model?.name).toBe("B")
  })
})
