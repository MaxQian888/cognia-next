/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"
import type { UIMessage } from "ai"

jest.mock("next-intl", () => ({ useLocale: () => "en" }))
jest.mock("@/lib/ai/generation/summarize-material", () => ({
  summarizeMaterial: jest.fn(),
}))
const buildClient = jest.fn(async (..._args: unknown[]) => ({ complete: jest.fn() }))
jest.mock("@/lib/ai/generation/agent-backed-client", () => ({
  buildAgentBackedLlmClient: (...args: unknown[]) => buildClient(...args),
}))
jest.mock("@/lib/db/sessions", () => ({
  getSession: jest.fn(async (id: string) => ({ id })),
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => ({ settings: {} }) },
}))
const chatState: Record<string, unknown> = {}
jest.mock("@/stores/chat/chat-store", () => ({
  useChatStore: { getState: () => chatState },
  selectVisibleMessages: (messages: UIMessage[]) => messages,
}))

import { summarizeMaterial } from "@/lib/ai/generation/summarize-material"
import {
  readVisibleSessionMessages,
  useConversationSummaryDraft,
} from "./use-conversation-summary-draft"

const summarize = summarizeMaterial as jest.Mock
const messages = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "We chose Postgres." }] },
  { id: "a1", role: "assistant", parts: [{ type: "text", text: "Noted." }] },
] as UIMessage[]

beforeEach(() => {
  summarize.mockReset()
  buildClient.mockClear()
  for (const key of Object.keys(chatState)) delete chatState[key]
})

describe("useConversationSummaryDraft", () => {
  it("drafts a model summary through the canonical summarizer and its turn label", async () => {
    summarize.mockResolvedValue({ kind: "summary", text: "Chose Postgres.", chunks: 1 })
    const { result } = renderHook(() =>
      useConversationSummaryDraft({ sessionId: "s1", turnLabel: "Background" })
    )
    await act(() => result.current.generate(messages))
    expect(result.current.text).toBe("Chose Postgres.")
    expect(result.current.fallback).toBeNull()
    expect(summarize.mock.calls[0][0]).toMatchObject({ purpose: "branch-seed", locale: "en" })
    expect(buildClient.mock.calls[0][0]).toMatchObject({ label: "Background" })
  })

  it("falls back to the digest and says why when no model summary is possible", async () => {
    summarize.mockResolvedValue({ kind: "unavailable", reason: "pii" })
    const { result } = renderHook(() =>
      useConversationSummaryDraft({ sessionId: "s1", turnLabel: "Background" })
    )
    await act(() => result.current.generate(messages))
    expect(result.current.fallback).toBe("pii")
    expect(result.current.text).toContain("We chose Postgres.")
  })

  it("reports a failure to the caller and stops generating", async () => {
    summarize.mockRejectedValue(new Error("boom"))
    const onError = jest.fn()
    const { result } = renderHook(() =>
      useConversationSummaryDraft({ sessionId: "s1", turnLabel: "Background", onError })
    )
    await act(() => result.current.generate(messages))
    expect(onError).toHaveBeenCalled()
    expect(result.current.generating).toBe(false)
  })

  it("resets the draft", async () => {
    summarize.mockResolvedValue({ kind: "unavailable", reason: "no-client" })
    const { result } = renderHook(() =>
      useConversationSummaryDraft({ sessionId: "s1", turnLabel: "Background" })
    )
    await act(() => result.current.generate(messages))
    act(() => result.current.reset())
    expect(result.current.text).toBe("")
    expect(result.current.fallback).toBeNull()
  })
})

describe("useConversationSummaryDraft across sessions", () => {
  it("never shows one session's draft for another", async () => {
    summarize.mockResolvedValue({ kind: "summary", text: "A's private summary", chunks: 1 })
    const { result, rerender } = renderHook(
      ({ sessionId }) => useConversationSummaryDraft({ sessionId, turnLabel: "Background" }),
      { initialProps: { sessionId: "a" } }
    )
    await act(() => result.current.generate(messages))
    expect(result.current.text).toBe("A's private summary")
    rerender({ sessionId: "b" })
    expect(result.current.text).toBe("")
    rerender({ sessionId: "a" })
    expect(result.current.text).toBe("A's private summary")
  })

  it("keeps a late summary in its own session and never overwrites the current draft", async () => {
    let finish!: (value: unknown) => void
    summarize.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    const { result, rerender } = renderHook(
      ({ sessionId }) => useConversationSummaryDraft({ sessionId, turnLabel: "Background" }),
      { initialProps: { sessionId: "a" } }
    )
    let pending!: Promise<void>
    act(() => {
      pending = result.current.generate(messages)
    })
    await waitFor(() => expect(summarize).toHaveBeenCalled())
    rerender({ sessionId: "b" })
    expect(result.current.generating).toBe(false)
    act(() => result.current.setText("B's own background"))
    await act(async () => {
      finish({ kind: "summary", text: "A's summary", chunks: 1 })
      await pending
    })
    expect(result.current.text).toBe("B's own background")
    rerender({ sessionId: "a" })
    expect(result.current.text).toBe("A's summary")
    expect(result.current.generating).toBe(false)
  })

  it("drops a draft that returns after its session was reset", async () => {
    let finish!: (value: unknown) => void
    summarize.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    const { result } = renderHook(() =>
      useConversationSummaryDraft({ sessionId: "a", turnLabel: "Background" })
    )
    let pending!: Promise<void>
    act(() => {
      pending = result.current.generate(messages)
    })
    await waitFor(() => expect(summarize).toHaveBeenCalled())
    act(() => result.current.reset())
    await act(async () => {
      finish({ kind: "summary", text: "late", chunks: 1 })
      await pending
    })
    expect(result.current.text).toBe("")
    expect(result.current.generating).toBe(false)
  })
})

describe("readVisibleSessionMessages", () => {
  it("reads the session's own slice, then the active session's top level", () => {
    chatState.sessions = { s1: { messages: [messages[0]], activeBranchByGroup: {} } }
    chatState.activeSessionId = "s2"
    chatState.messages = [messages[1]]
    chatState.activeBranchByGroup = {}
    expect(readVisibleSessionMessages("s1")).toEqual([messages[0]])
    expect(readVisibleSessionMessages("s2")).toEqual([messages[1]])
    expect(readVisibleSessionMessages("s3")).toEqual([])
  })
})
