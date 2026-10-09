/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"

import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import { useSettingsStore } from "@/stores/settings"
import type { ExternalAgentModelSurface } from "@/lib/ai/agent/external/session/session-models"
import type { ChatSession } from "@cognia/agent-config-types"
import { useExternalAgentActiveModel } from "./use-external-agent-active-model"

const surface: ExternalAgentModelSurface = {
  choices: [
    { modelId: "p/a", name: "A", capabilities: { contextWindow: 128_000 } },
    { modelId: "p/b", name: "B", capabilities: { contextWindow: 1_000_000 } },
  ],
  currentModelId: null,
  write: { kind: "session-seed" },
}

beforeEach(() => {
  useExternalAgentStore.setState({ agents: {} })
  useSettingsStore.setState({ settings: {} } as never)
})

describe("useExternalAgentActiveModel", () => {
  it("answers nothing on a built-in lane", () => {
    const { result } = renderHook(() => useExternalAgentActiveModel(null, null, surface))
    expect(result.current).toEqual({ modelId: undefined, model: undefined })
  })

  it("names the conversation's pick from the catalog", () => {
    const session = { id: "s", externalAgentModels: { pi: { kind: "native", modelId: "p/b" } } }
    const { result } = renderHook(() =>
      useExternalAgentActiveModel("pi", session as unknown as ChatSession, surface)
    )
    expect(result.current.model?.capabilities?.contextWindow).toBe(1_000_000)
  })

  it("follows the app default a welcome-screen pick writes", () => {
    const { result } = renderHook(() => useExternalAgentActiveModel("pi", null, surface))
    expect(result.current.modelId).toBeUndefined()
    act(() => {
      useSettingsStore.setState({
        settings: { externalAgentModelDefaults: { pi: { kind: "native", modelId: "p/a" } } },
      } as never)
    })
    expect(result.current.model?.name).toBe("A")
  })
})
