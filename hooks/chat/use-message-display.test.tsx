/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"

import { useSettingsStore } from "@/stores/settings/settings-store"
import { useMessageDisplay } from "./use-message-display"

describe("useMessageDisplay", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      settings: {
        messageDisplay: { preset: "focused" },
        agentFlowMode: { mode: "detailed" },
      } as never,
    })
  })

  it("resolves global preferences and a session override", () => {
    const { result } = renderHook(() =>
      useMessageDisplay({ preset: "inspector", overrides: { layout: "cards" } })
    )

    expect(result.current.preset).toBe("inspector")
    expect(result.current.layout).toBe("cards")
    expect(result.current.agentFlowMode).toBe("detailed")
  })

  it("keeps the legacy agent-flow value when unified overrides are absent", () => {
    const { result } = renderHook(() => useMessageDisplay())

    expect(result.current.preset).toBe("focused")
    expect(result.current.agentFlowMode).toBe("detailed")
  })
})
