/** @jest-environment jsdom */
import { createElement } from "react"
import { act, render, renderHook } from "@testing-library/react"

import type { ChatSession, ExternalAgentCogniaModelBinding } from "@cognia/agent-config-types"
import { useSettingsStore } from "@/stores/settings"
import { useChatStore } from "@/stores/chat"
import { ContextUsageIndicator } from "@/components/chat/context-usage-indicator"
import { externalTokenUsageToUsageInfo } from "@/lib/claude/usage"
import { translateDshNotification } from "@cognia/agent-dsh/event-codec"
import { useAgentContextWindow } from "./use-agent-context-window"

let mockAgentId: string | null = null
const mockSurface = { choices: [] }
let mockActive: {
  modelId?: string
  model?: { capabilities?: { contextWindow?: number } }
  cognia?: ExternalAgentCogniaModelBinding
} = {}
const activeCalls: unknown[][] = []

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
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
  useSettingsStore.setState({ settings: {} } as never)
  useChatStore.getState().clear()
})

describe("useAgentContextWindow", () => {
  it("renders DSH cached request occupancy without counting cached input twice", () => {
    mockAgentId = "deepseek-harness"
    mockActive = { model: { capabilities: { contextWindow: 1_000_000 } } }
    const events = translateDshNotification({
      method: "session.event",
      params: {
        sessionId: "s1",
        event: {
          type: "assistant/message",
          seq: 1,
          time: 1,
          data: {
            message: { id: "reply", content: [] },
            usage: { inputTokens: 10, cacheReadTokens: 20, outputTokens: 2 },
          },
        },
      },
    }).events
    const end = events.find((event) => event.type === "message_end")
    if (end?.type !== "message_end" || !end.tokenUsage) throw new Error("Missing DSH usage")
    useChatStore.getState().replaceMessages([
      {
        id: "reply",
        role: "assistant",
        parts: [{ type: "text", text: "answer" }],
        metadata: { usage: externalTokenUsageToUsageInfo(end.tokenUsage) },
      },
    ])
    const { container } = render(
      createElement(ContextUsageIndicator, { modelId: "deepseek-flash" })
    )
    expect(container.querySelector("[data-used-tokens]")).toHaveAttribute("data-used-tokens", "32")
  })

  it("renders a new gateway selection even when the last reply used another model", () => {
    mockAgentId = "deepseek-harness"
    mockActive = { cognia: { providerId: "gateway", modelId: "large" } }
    useSettingsStore.setState({
      settings: {
        providerSettings: {
          gateway: {
            discoveredModels: [
              { id: "large", contextLength: 1_000_000 },
              { id: "small", contextLength: 64_000 },
            ],
          },
        },
      },
    } as never)
    function SelectedContext() {
      const window = useAgentContextWindow(session)
      return createElement(ContextUsageIndicator, {
        modelId: "unrelated-builtin-model",
        maxTokens: window?.maxTokens,
        selectedModelContextWindow:
          window?.source === "cognia" ? (window.maxTokens ?? null) : undefined,
      })
    }
    const { container, rerender } = render(createElement(SelectedContext))
    const indicator = () => container.querySelector("[data-max-tokens]")
    expect(indicator()).toHaveAttribute("data-max-tokens", "1000000")
    mockActive = { cognia: { providerId: "gateway", modelId: "small" } }
    rerender(createElement(SelectedContext))
    expect(indicator()).toHaveAttribute("data-max-tokens", "64000")
    act(() => {
      useChatStore.getState().replaceMessages([
        {
          id: "reply",
          role: "assistant",
          parts: [{ type: "text", text: "answer" }],
          metadata: {
            usage: externalTokenUsageToUsageInfo({
              promptTokens: 100,
              completionTokens: 5,
              totalTokens: 105,
              modelContextWindow: 64_000,
            }),
          },
        },
      ])
    })
    expect(indicator()).toHaveAttribute("data-max-tokens", "64000")
    mockActive = { cognia: { providerId: "gateway", modelId: "large" } }
    rerender(createElement(SelectedContext))
    expect(indicator()).toHaveAttribute("data-max-tokens", "1000000")
    mockActive = { cognia: { providerId: "gateway", modelId: "unknown" } }
    rerender(createElement(SelectedContext))
    expect(indicator()).toHaveAttribute("data-window-source", "unknown")
    expect(indicator()).toHaveAttribute("data-max-tokens", "0")
    expect(container.querySelector("[data-reported]")).toHaveAttribute("data-reported", "false")
  })

  it("follows the selected Cognia model and refreshed provider metadata on DSH", () => {
    mockAgentId = "deepseek-harness"
    mockActive = { cognia: { providerId: "gateway", modelId: "large" } }
    useSettingsStore.setState({
      settings: {
        providerSettings: {
          gateway: {
            discoveredModels: [
              { id: "large", contextLength: 1_000_000 },
              { id: "small", contextLength: 64_000 },
            ],
          },
        },
      },
    } as never)
    const { result, rerender } = renderHook(() => useAgentContextWindow(session))
    expect(result.current?.maxTokens).toBe(1_000_000)
    mockActive = { cognia: { providerId: "gateway", modelId: "small" } }
    rerender()
    expect(result.current?.maxTokens).toBe(64_000)
    act(() => {
      useSettingsStore.setState({
        settings: {
          providerSettings: {
            gateway: { discoveredModels: [{ id: "small", contextLength: 256_000 }] },
          },
        },
      } as never)
    })
    expect(result.current?.maxTokens).toBe(256_000)
  })

  it("uses custom-provider overrides for a Cognia binding instead of the native catalog", () => {
    mockAgentId = "deepseek-harness"
    mockActive = {
      cognia: { providerId: "custom", modelId: "same-id" },
      model: { capabilities: { contextWindow: 128_000 } },
    }
    useSettingsStore.setState({
      settings: {
        customProviders: [
          {
            id: "custom",
            discoveredModels: [{ id: "same-id", contextLength: 64_000 }],
            customModelMetadata: { "same-id": { id: "same-id", contextLength: 500_000 } },
          },
        ],
      },
    } as never)
    const { result } = renderHook(() => useAgentContextWindow(session))
    expect(result.current?.maxTokens).toBe(500_000)
  })

  it("leaves unknown Cognia model capacity unknown", () => {
    mockAgentId = "deepseek-harness"
    mockActive = { cognia: { providerId: "unknown", modelId: "unknown" } }
    const { result } = renderHook(() => useAgentContextWindow(session))
    expect(result.current).toEqual({ maxTokens: undefined, source: "cognia" })
  })
  it("matches the input ceiling configured on the selected gateway model", () => {
    mockAgentId = "deepseek-harness"
    mockActive = { cognia: { providerId: "gateway", modelId: "large" } }
    useSettingsStore.setState({
      settings: {
        providerSettings: {
          gateway: {
            discoveredModels: [{ id: "large", contextLength: 1_000_000, maxInputTokens: 900_000 }],
          },
        },
      },
    } as never)
    const { result } = renderHook(() => useAgentContextWindow(session))
    expect(result.current).toEqual({ maxTokens: 900_000, source: "cognia" })
  })
  it("is the window the agent's catalog reports for the model this conversation runs", () => {
    mockAgentId = "pi"
    mockActive = {
      modelId: "deepseek/flash",
      model: { capabilities: { contextWindow: 1_000_000 } },
    }
    const { result } = renderHook(() => useAgentContextWindow(session))
    expect(result.current?.maxTokens).toBe(1_000_000)
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
