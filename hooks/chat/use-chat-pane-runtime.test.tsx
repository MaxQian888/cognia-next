import { act, renderHook } from "@testing-library/react"
import { useChatStore } from "@/stores/chat"
import { useChatPaneRuntime } from "./use-chat-pane-runtime"

const send = jest.fn(async () => undefined)
const updateSession = jest.fn<Promise<void>, unknown[]>(async () => undefined)
jest.mock("./use-claude-chat", () => ({ useClaudeChat: () => ({ send }) }))
jest.mock("@/lib/db/sessions", () => ({
  updateSession: (...args: unknown[]) => updateSession(...args),
}))

beforeEach(() => {
  useChatStore.getState().clear()
  jest.clearAllMocks()
})

it("transfers dialog ownership when one of two surfaces closes without changing focus", () => {
  useChatStore.getState().setActiveSession("main")
  const first = renderHook(() => useChatPaneRuntime("aside"))
  const second = renderHook(() => useChatPaneRuntime("aside"))
  expect(first.result.current.ownsDecisions).toBe(true)
  expect(second.result.current.ownsDecisions).toBe(false)
  first.unmount()
  expect(second.result.current.ownsDecisions).toBe(true)
  expect(useChatStore.getState().activeSessionId).toBe("main")
  expect(useChatStore.getState().openSessionIds).toEqual(["main"])
  second.unmount()
  expect(useChatStore.getState().paneIdsBySession.aside).toBeUndefined()
})

it("moves registration when the surface changes session", () => {
  const { rerender } = renderHook(({ id }) => useChatPaneRuntime(id), { initialProps: { id: "a" } })
  rerender({ id: "b" })
  expect(useChatStore.getState().paneIdsBySession.a).toBeUndefined()
  expect(useChatStore.getState().paneIdsBySession.b).toHaveLength(1)
})

it("persists plan mode on the bound session before resuming without a user bubble", async () => {
  useChatStore.getState().setActiveSession("other")
  const { result } = renderHook(() => useChatPaneRuntime("plan-session"))
  await act(async () => result.current.resumePlan("Implement the approved plan", "acceptEdits"))
  expect(updateSession).toHaveBeenCalledWith("plan-session", { permissionMode: "acceptEdits" })
  expect(send).toHaveBeenCalledWith("Implement the approved plan", undefined, {
    sessionId: "plan-session",
    skipUserAppend: true,
    throwOnError: true,
  })
  expect(useChatStore.getState().sessions["plan-session"].permissionMode).toBe("acceptEdits")
  expect(useChatStore.getState().permissionMode).toBeNull()
})

it("does not send a continuation when persisting the approved mode fails", async () => {
  updateSession.mockRejectedValueOnce(new Error("host unavailable"))
  const { result } = renderHook(() => useChatPaneRuntime("plan-session"))
  await expect(result.current.resumePlan("go", "default")).rejects.toThrow("host unavailable")
  expect(send).not.toHaveBeenCalled()
})

it("does not register or resume an absent conversation", async () => {
  const { result } = renderHook(() => useChatPaneRuntime(null))
  expect(result.current.ownsDecisions).toBe(false)
  await result.current.resumePlan("go", "default")
  expect(useChatStore.getState().paneIdsBySession).toEqual({})
  expect(updateSession).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
})

it("restores the existing mode when persistence fails", async () => {
  useChatStore.getState().setPermissionMode("acceptEdits", "plan-session")
  updateSession.mockRejectedValueOnce(new Error("write failed"))
  const { result } = renderHook(() => useChatPaneRuntime("plan-session"))
  await expect(result.current.resumePlan("go", "default")).rejects.toThrow("write failed")
  expect(useChatStore.getState().sessions["plan-session"].permissionMode).toBe("acceptEdits")
})
