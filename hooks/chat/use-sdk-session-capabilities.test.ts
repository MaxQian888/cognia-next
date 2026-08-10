/**
 * @jest-environment jsdom
 */

let mockStatus = "idle"
jest.mock("@/stores/chat", () => ({
  useChatStore: (sel: (s: { status: string }) => unknown) => sel({ status: mockStatus }),
}))

const mockIsTauri = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => mockIsTauri() }))

const getSessionSupportedModels = jest.fn()
const getSessionSupportedCommands = jest.fn()
const subscribeAgentEvents = jest.fn()
jest.mock("@/lib/claude/ipc", () => ({
  getSessionSupportedModels: (...a: unknown[]) => getSessionSupportedModels(...a),
  getSessionSupportedCommands: (...a: unknown[]) => getSessionSupportedCommands(...a),
  subscribeAgentEvents: (...a: unknown[]) => subscribeAgentEvents(...a),
}))

import { act, renderHook, waitFor } from "@testing-library/react"
import { useSdkSessionCapabilities } from "./use-sdk-session-capabilities"

const MODELS = [{ value: "m", displayName: "M", description: "d" }]
const COMMANDS = [{ name: "compact", description: "c" }]

beforeEach(() => {
  jest.clearAllMocks()
  mockStatus = "idle"
  mockIsTauri.mockReturnValue(true)
  subscribeAgentEvents.mockResolvedValue(jest.fn())
})

describe("useSdkSessionCapabilities", () => {
  it("fetches models + commands on mount", async () => {
    getSessionSupportedModels.mockResolvedValue(MODELS)
    getSessionSupportedCommands.mockResolvedValue(COMMANDS)
    const { result } = renderHook(() => useSdkSessionCapabilities("s1", "anthropic"))
    await waitFor(() => expect(result.current.models).toEqual(MODELS))
    expect(result.current.commands).toEqual(COMMANDS)
    expect(getSessionSupportedModels).toHaveBeenCalledWith("s1")
    expect(getSessionSupportedCommands).toHaveBeenCalledWith("s1")
  })

  it("clears lists when control calls reject", async () => {
    getSessionSupportedModels.mockRejectedValue(new Error("unsupported_provider"))
    getSessionSupportedCommands.mockRejectedValue(new Error("unsupported_provider"))
    const { result } = renderHook(() => useSdkSessionCapabilities("s1"))
    await waitFor(() => expect(getSessionSupportedModels).toHaveBeenCalled())
    expect(result.current.models).toBeNull()
    expect(result.current.commands).toBeNull()
  })

  it("stays disabled for non-Anthropic providers and in web mode", async () => {
    getSessionSupportedModels.mockResolvedValue(MODELS)
    renderHook(() => useSdkSessionCapabilities("s1", "openai"))
    mockIsTauri.mockReturnValue(false)
    renderHook(() => useSdkSessionCapabilities("s1", "anthropic"))
    await act(async () => {
      await Promise.resolve()
    })
    expect(getSessionSupportedModels).not.toHaveBeenCalled()
  })

  it("re-fetches after a completed turn (busy → idle)", async () => {
    getSessionSupportedModels.mockResolvedValue(MODELS)
    getSessionSupportedCommands.mockResolvedValue(COMMANDS)
    mockStatus = "streaming"
    const { rerender } = renderHook(() => useSdkSessionCapabilities("s1"))
    await waitFor(() => expect(getSessionSupportedCommands).toHaveBeenCalled())
    getSessionSupportedCommands.mockClear()
    mockStatus = "idle"
    rerender()
    await waitFor(() => expect(getSessionSupportedCommands).toHaveBeenCalledWith("s1"))
  })

  it("refreshes the existing capability lists on canonical commands-changed", async () => {
    getSessionSupportedModels.mockResolvedValue(MODELS)
    getSessionSupportedCommands.mockResolvedValue(COMMANDS)
    renderHook(() => useSdkSessionCapabilities("s1"))
    await waitFor(() => expect(subscribeAgentEvents).toHaveBeenCalled())
    getSessionSupportedModels.mockClear()
    getSessionSupportedCommands.mockClear()

    const onEnvelope = subscribeAgentEvents.mock.calls[0]?.[0]
    act(() => {
      onEnvelope({ sessionId: "other", event: { kind: "commands-changed" } })
      onEnvelope({ sessionId: "s1", event: { kind: "commands-changed" } })
    })

    await waitFor(() => expect(getSessionSupportedModels).toHaveBeenCalledWith("s1"))
    expect(getSessionSupportedCommands).toHaveBeenCalledWith("s1")
  })
})
