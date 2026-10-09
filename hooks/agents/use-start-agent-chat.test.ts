/**
 * @jest-environment jsdom
 */

const mockRouter = { push: jest.fn() }
jest.mock("next/navigation", () => ({ useRouter: () => mockRouter }))

const mockToast = { error: jest.fn() }
jest.mock("sonner", () => ({
  get toast() {
    return mockToast
  },
}))

jest.mock("@/lib/chat/start-session", () => ({ startNewSession: jest.fn() }))

import { act, renderHook } from "@testing-library/react"
import { startNewSession } from "@/lib/chat/start-session"
import { useStartAgentChat } from "./use-start-agent-chat"

const startMock = startNewSession as jest.Mock

beforeEach(() => {
  mockRouter.push.mockReset()
  mockToast.error.mockReset()
  startMock.mockReset()
})

describe("useStartAgentChat", () => {
  it("is idle before anything starts", () => {
    const { result } = renderHook(() => useStartAgentChat())
    expect(result.current.starting).toBe(false)
  })

  it("starts a direct chat bound to the agent and opens it", async () => {
    startMock.mockResolvedValue({ id: "sess 1" })
    const { result } = renderHook(() => useStartAgentChat())
    await act(() => result.current.start({ id: "char_1", name: "Reviewer" }))
    expect(startMock).toHaveBeenCalledWith({
      title: "Chat with Reviewer",
      kind: "direct",
      characterId: "char_1",
    })
    expect(mockRouter.push).toHaveBeenCalledWith("/?session=sess%201")
    expect(mockToast.error).not.toHaveBeenCalled()
    expect(result.current.starting).toBe(false)
  })

  it("reports starting while the session is being created", async () => {
    let resolve: (value: { id: string }) => void = () => {}
    startMock.mockReturnValue(new Promise((r) => (resolve = r)))
    const { result } = renderHook(() => useStartAgentChat())
    let pending: Promise<void> = Promise.resolve()
    act(() => {
      pending = result.current.start({ id: "char_1", name: "Reviewer" })
    })
    expect(result.current.starting).toBe(true)
    await act(async () => {
      resolve({ id: "s1" })
      await pending
    })
    expect(result.current.starting).toBe(false)
  })

  it("toasts the error message and stays put when the session cannot start", async () => {
    startMock.mockRejectedValue(new Error("No provider configured"))
    const { result } = renderHook(() => useStartAgentChat())
    await act(() => result.current.start({ id: "char_1", name: "Reviewer" }))
    expect(mockToast.error).toHaveBeenCalledWith("Couldn't start a conversation with this agent", {
      description: "No provider configured",
    })
    expect(mockRouter.push).not.toHaveBeenCalled()
    expect(result.current.starting).toBe(false)
  })

  it("stringifies a non-Error failure", async () => {
    startMock.mockRejectedValue("offline")
    const { result } = renderHook(() => useStartAgentChat())
    await act(() => result.current.start({ id: "char_1", name: "Reviewer" }))
    expect(mockToast.error).toHaveBeenCalledWith(expect.any(String), { description: "offline" })
  })
})
