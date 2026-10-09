/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"

import { useSettingsStore } from "@/stores/settings"
import { resolveModelMeta } from "@/lib/ai/model-options"
import type { ChatSession } from "@cognia/agent-config-types"

let mockAgent: { agentId: string | null; agentName: string | null } = {
  agentId: null,
  agentName: null,
}
jest.mock("@/hooks/agent/use-external-agent-models", () => ({
  useExternalAgentModels: () => ({ ...mockAgent, surface: null }),
}))

import { useComposerImageInput } from "./use-composer-image-input"

const session = (model: string, providerOverride: string) =>
  ({ id: "s", model, providerOverride }) as unknown as ChatSession

beforeEach(() => {
  mockAgent = { agentId: null, agentName: null }
  useSettingsStore.setState({ settings: {} } as never)
})

describe("useComposerImageInput", () => {
  it("says an external agent's lane takes text only, whatever its model reads", () => {
    mockAgent = { agentId: "pi", agentName: "Pi (native RPC)" }
    const { result } = renderHook(() => useComposerImageInput(null))
    expect(result.current).toEqual({
      accepted: false,
      reason: "text-only-agent",
      agentName: "Pi (native RPC)",
    })
  })

  it("flags a built-in model whose catalog says it has no vision", () => {
    // Sanity: the catalog fact this test leans on.
    expect(resolveModelMeta("deepseek", "deepseek-v4-pro").supportsVision).toBe(false)
    const { result } = renderHook(() =>
      useComposerImageInput(session("deepseek-v4-pro", "deepseek"))
    )
    expect(result.current).toEqual({
      accepted: false,
      reason: "model-no-vision",
      modelName: "DeepSeek V4 Pro",
    })
  })

  it("accepts a model the catalog says reads images, or says nothing about", () => {
    const vision = renderHook(() => useComposerImageInput(session("claude-sonnet-5", "anthropic")))
    expect(vision.result.current).toEqual({ accepted: true })
    const unknown = renderHook(() => useComposerImageInput(session("mystery-model", "custom-x")))
    expect(unknown.result.current).toEqual({ accepted: true })
  })

  it("follows the app default when the conversation has no model of its own", () => {
    const { result } = renderHook(() => useComposerImageInput(null))
    expect(result.current.accepted).toBe(true)
    act(() => {
      useSettingsStore.setState({
        settings: { defaultModel: "deepseek-v4-pro", defaultProvider: "deepseek" },
      } as never)
    })
    expect(result.current.accepted).toBe(false)
  })
})
