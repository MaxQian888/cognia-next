/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"
import type { UIMessage } from "ai"
import type { SdkContextUsage } from "@cognia/agent-config-types"

import { useSessionContextWindow } from "./use-session-context-window"

const sdk: { snapshot: SdkContextUsage | null } = { snapshot: null }
const refresh = jest.fn()
jest.mock("@/hooks/chat/use-sdk-context-usage", () => ({
  useSdkContextUsage: () => ({ snapshot: sdk.snapshot, refresh }),
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) => selector({ settings: {} }),
}))

function assistant(id: string, usage?: Record<string, number>, provider?: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text: "hi" }],
    metadata: { ...(usage ? { usage } : {}), ...(provider ? { runProviderId: provider } : {}) },
  } as unknown as UIMessage
}

beforeEach(() => {
  sdk.snapshot = null
})

describe("useSessionContextWindow", () => {
  it("estimates from the latest turn's usage without a live snapshot", () => {
    const messages = [assistant("a1", { inputTokens: 4000, outputTokens: 100 })]
    const { result } = renderHook(() =>
      useSessionContextWindow({ sessionId: "s", messages, modelId: "claude-sonnet-4-6" })
    )
    expect(result.current.win.reported).toBe(true)
    expect(result.current.win.used).toBeGreaterThan(0)
    expect(result.current.breakdown.source).toBe("estimate")
    expect(result.current.compaction.source).toBe("builtin")
    expect(result.current.assistantTurns).toBe(1)
    expect(result.current.refresh).toBe(refresh)
  })

  it("switches to the live snapshot when the runtime reports one", () => {
    sdk.snapshot = {
      totalTokens: 30_000,
      maxTokens: 200_000,
      percentage: 15,
      categories: [{ name: "Messages", tokens: 30_000 }],
    }
    const { result } = renderHook(() =>
      useSessionContextWindow({ sessionId: "s", messages: [], modelId: "x" })
    )
    expect(result.current.win).toMatchObject({ used: 30_000, max: 200_000, windowSource: "agent" })
    expect(result.current.breakdown.source).toBe("live")
    expect(result.current.compaction.source).toBe("sdk")
  })

  it("reports an unknown occupancy for a session with no usage yet", () => {
    const { result } = renderHook(() =>
      useSessionContextWindow({ sessionId: "s", messages: [], modelId: "x" })
    )
    expect(result.current.win.reported).toBe(false)
    expect(result.current.compaction.source).toBe("unknown")
    expect(result.current.assistantTurns).toBe(0)
  })
})
