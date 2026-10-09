/** @jest-environment jsdom */
import { renderHook } from "@testing-library/react"

import type { ChatSession } from "@cognia/agent-config-types"
import { useAgentContextWindow } from "./use-agent-context-window"

let mockAgentId: string | null = null
const mockSurface = { choices: [] }
let mockActive: { modelId?: string; model?: { capabilities?: { contextWindow?: number } } } = {}
const activeCalls: unknown[][] = []

jest.mock("@/hooks/agent/use-external-agent-models", () => ({
  useExternalAgentModels: () => ({ agentId: mockAgentId, surface: mockSurface }),
}))
jest.mock("@/hooks/agent/use-external-agent-active-model", () => ({
  useExternalAgentActiveModel: (...args: unknown[]) => {
    activeCalls.push(args)
    return mockActive
  },
}))

const session = { id: "s1" } as ChatSession

beforeEach(() => {
  mockAgentId = null
  mockActive = {}
  activeCalls.length = 0
})

describe("useAgentContextWindow", () => {
  it("is the window the agent's catalog reports for the model this conversation runs", () => {
    mockAgentId = "pi"
    mockActive = {
      modelId: "deepseek/flash",
      model: { capabilities: { contextWindow: 1_000_000 } },
    }
    const { result } = renderHook(() => useAgentContextWindow(session))
    expect(result.current).toBe(1_000_000)
    expect(activeCalls.at(-1)).toEqual(["pi", session, mockSurface])
  })

  it("is undefined for a model whose catalog entry carries no window", () => {
    mockAgentId = "pi"
    mockActive = { modelId: "legacy", model: {} }
    const { result } = renderHook(() => useAgentContextWindow(session))
    expect(result.current).toBeUndefined()
  })

  it("is undefined off an agent's lane, whatever the active-model hook answers", () => {
    mockActive = { modelId: "x", model: { capabilities: { contextWindow: 9 } } }
    const { result } = renderHook(() => useAgentContextWindow(session))
    expect(result.current).toBeUndefined()
  })
})
