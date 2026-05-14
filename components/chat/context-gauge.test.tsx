/**
 * @jest-environment jsdom
 */
import React from "react"
import { act, render, screen } from "@testing-library/react"
import type { UIMessage } from "ai"
import { ContextGauge, contextWindowForModel } from "./context-gauge"
import { useChatStore } from "@/stores/chat"

const assistantWithUsage = (id: string, usage: Record<string, number>): UIMessage =>
  ({
    id,
    role: "assistant",
    parts: [{ type: "text", text: "hi" }],
    metadata: { usage },
  }) as unknown as UIMessage

describe("contextWindowForModel", () => {
  it("returns 1M for the Opus 4.7 1M build", () => {
    expect(contextWindowForModel("claude-opus-4-7[1m]")).toBe(1_000_000)
  })

  it("returns 200K for generic Claude 4 models", () => {
    expect(contextWindowForModel("claude-sonnet-4-6")).toBe(200_000)
    expect(contextWindowForModel("claude-haiku-4-5-20251001")).toBe(200_000)
  })

  it("returns 128K for GPT-4o variants", () => {
    expect(contextWindowForModel("gpt-4o-mini")).toBe(128_000)
  })

  it("falls back to 200K for unknown / undefined models", () => {
    expect(contextWindowForModel(undefined)).toBe(200_000)
    expect(contextWindowForModel("some-future-model")).toBe(200_000)
  })
})

describe("ContextGauge", () => {
  beforeEach(() => {
    useChatStore.getState().clear()
  })

  it("renders nothing when no assistant message carries usage", () => {
    const { container } = render(<ContextGauge modelId="claude-sonnet-4-6" />)
    expect(container.firstChild).toBeNull()
  })

  it("uses the most-recent assistant usage to compute the ring", () => {
    act(() => {
      useChatStore.getState().replaceMessages([
        assistantWithUsage("a-1", { inputTokens: 100, outputTokens: 50 }),
        assistantWithUsage("a-2", {
          inputTokens: 200,
          outputTokens: 100,
          cacheReadInputTokens: 20,
        }),
      ])
    })
    render(<ContextGauge modelId="claude-sonnet-4-6" />)

    const node = screen.getByTestId("context-gauge")
    expect(node).toHaveAttribute("data-max-tokens", "200000")
    expect(node).toHaveAttribute("data-used-tokens", "320")
  })

  it("respects an explicit maxTokens override", () => {
    act(() => {
      useChatStore
        .getState()
        .replaceMessages([assistantWithUsage("a-1", { inputTokens: 10, outputTokens: 5 })])
    })
    render(<ContextGauge modelId="claude-sonnet-4-6" maxTokens={4096} />)
    const node = screen.getByTestId("context-gauge")
    expect(node).toHaveAttribute("data-max-tokens", "4096")
    expect(node).toHaveAttribute("data-used-tokens", "15")
  })

  it("treats messages without metadata.usage as no signal", () => {
    act(() => {
      useChatStore
        .getState()
        .replaceMessages([{ id: "a-1", role: "assistant", parts: [] } as unknown as UIMessage])
    })
    const { container } = render(<ContextGauge modelId="claude-sonnet-4-6" />)
    expect(container.firstChild).toBeNull()
  })
})
