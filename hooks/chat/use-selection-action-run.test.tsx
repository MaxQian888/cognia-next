/** @jest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react"

import type { LlmClient } from "@/lib/twin/distill/llm"
import { useSelectionActionRun, type SelectionRunRequest } from "./use-selection-action-run"

const mockBuildClient = jest.fn()
jest.mock("@/lib/ai/generation/agent-backed-client", () => ({
  buildAgentBackedLlmClient: (...args: unknown[]) => mockBuildClient(...args),
}))

const mockGetSession = jest.fn()
jest.mock("@/lib/db/sessions", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}))

const mockLoadBodies = jest.fn()
jest.mock("@/lib/chat/selection/message-excerpt", () => ({
  loadMessageBodies: (...args: unknown[]) => mockLoadBodies(...args),
}))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => ({ settings: { defaultProvider: "anthropic" } }) },
}))

const request = (over: Partial<SelectionRunRequest> = {}): SelectionRunRequest => ({
  action: "explain",
  quote: "memoize the selector",
  sessionId: "s1",
  messageIds: ["m1"],
  context: "To stop re-renders, memoize the selector.",
  ...over,
})

function client(complete: LlmClient["complete"]): LlmClient {
  return { complete: jest.fn(complete) }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGetSession.mockResolvedValue({ id: "s1", model: "opus" })
  mockLoadBodies.mockResolvedValue(null)
})

describe("useSelectionActionRun", () => {
  it("builds the agent-backed client for the selection's conversation and shows the result", async () => {
    const llm = client(async () => "It caches the result.")
    mockBuildClient.mockResolvedValue(llm)
    const { result } = renderHook(() => useSelectionActionRun())

    await act(async () => {
      await result.current.run(request())
    })

    expect(mockGetSession).toHaveBeenCalledWith("s1")
    expect(mockBuildClient).toHaveBeenCalledWith(
      expect.objectContaining({
        session: { id: "s1", model: "opus" },
        featureId: "chat-selection-actions",
        label: "Selection explanation",
      })
    )
    expect(result.current.state).toEqual({
      status: "done",
      request: request(),
      text: "It caches the result.",
      parts: 1,
    })
    // An explanation is written in the UI's language — `en` under the suite's
    // global next-intl mock.
    const [prompt] = (llm.complete as jest.Mock).mock.calls[0]!
    expect(prompt).toContain("Write the explanation in English.")
  })

  // The rendered row also carries timestamps and button labels; the stored body
  // is what the message says.
  it("explains against the stored messages, falling back to the rendered text", async () => {
    const llm = client(async () => "ok")
    mockBuildClient.mockResolvedValue(llm)
    mockLoadBodies.mockResolvedValueOnce("the stored message body")
    const { result } = renderHook(() => useSelectionActionRun())
    await act(async () => {
      await result.current.run(request())
    })
    expect(mockLoadBodies).toHaveBeenCalledWith("s1", ["m1"])
    expect((llm.complete as jest.Mock).mock.calls[0]![0]).toContain("the stored message body")

    await act(async () => {
      await result.current.run(request())
    })
    expect((llm.complete as jest.Mock).mock.calls[1]![0]).toContain(
      "To stop re-renders, memoize the selector."
    )
  })

  it("translates into the chosen language, not the UI's", async () => {
    const llm = client(async () => "Mémoïser")
    mockBuildClient.mockResolvedValue(llm)
    const { result } = renderHook(() => useSelectionActionRun())
    await act(async () => {
      await result.current.run(request({ action: "translate", targetLocale: "fr" }))
    })
    const [prompt] = (llm.complete as jest.Mock).mock.calls[0]!
    expect(prompt).toContain("into French")
  })

  it("says why nothing ran when no model is reachable", async () => {
    mockBuildClient.mockResolvedValue(null)
    const { result } = renderHook(() => useSelectionActionRun())
    await act(async () => {
      await result.current.run(request({ action: "summarize" }))
    })
    expect(result.current.state).toMatchObject({ status: "unavailable", reason: "no-client" })
  })

  it("reports a provider failure with its message", async () => {
    mockBuildClient.mockResolvedValue(
      client(async () => {
        throw new Error("rate limited")
      })
    )
    const { result } = renderHook(() => useSelectionActionRun())
    await act(async () => {
      await result.current.run(request())
    })
    expect(result.current.state).toMatchObject({ status: "failed", message: "rate limited" })
  })

  it("stops on request and keeps the run's request for a retry", async () => {
    let rejectCall: ((error: unknown) => void) | null = null
    mockBuildClient.mockResolvedValue(
      client(
        (_prompt, options) =>
          new Promise((_resolve, reject) => {
            rejectCall = reject
            options?.abortSignal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError"))
            )
          })
      )
    )
    const { result } = renderHook(() => useSelectionActionRun())
    let pending: Promise<void> | undefined
    act(() => {
      pending = result.current.run(request())
    })
    await waitFor(() => expect(rejectCall).not.toBeNull())
    await act(async () => {
      result.current.stop()
      await pending
    })
    expect(result.current.state).toMatchObject({ status: "stopped", request: request(), text: "" })
  })

  // Two quick actions in a row: the first answer must not land under the second
  // action's title.
  it("drops a superseded run's late result", async () => {
    const resolvers: ((text: string) => void)[] = []
    mockBuildClient.mockResolvedValue(
      client(
        (_prompt, options) =>
          new Promise((resolve, reject) => {
            resolvers.push(resolve)
            options?.abortSignal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError"))
            )
          })
      )
    )
    const { result } = renderHook(() => useSelectionActionRun())
    let first: Promise<void> | undefined
    let second: Promise<void> | undefined
    act(() => {
      first = result.current.run(request({ action: "explain" }))
    })
    await waitFor(() => expect(resolvers).toHaveLength(1))
    act(() => {
      second = result.current.run(request({ action: "summarize" }))
    })
    await waitFor(() => expect(resolvers).toHaveLength(2))
    await act(async () => {
      resolvers[0]!("the explanation")
      resolvers[1]!("the summary")
      await Promise.allSettled([first, second])
    })
    expect(result.current.state).toMatchObject({
      status: "done",
      request: { action: "summarize" },
      text: "the summary",
    })
  })

  it("closes back to idle and ignores what the closed run produces", async () => {
    let resolveCall: ((text: string) => void) | null = null
    mockBuildClient.mockResolvedValue(
      client(
        () =>
          new Promise((resolve) => {
            resolveCall = resolve
          })
      )
    )
    const { result } = renderHook(() => useSelectionActionRun())
    let pending: Promise<void> | undefined
    act(() => {
      pending = result.current.run(request())
    })
    await waitFor(() => expect(resolveCall).not.toBeNull())
    act(() => result.current.close())
    await act(async () => {
      resolveCall!("too late")
      await pending
    })
    expect(result.current.state).toEqual({ status: "idle" })
  })
})
