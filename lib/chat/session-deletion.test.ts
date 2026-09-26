/**
 * @jest-environment jsdom
 */

const closeSessionMock = jest.fn()
jest.mock("@/lib/claude/ipc", () => ({
  closeSession: (id: string) => closeSessionMock(id),
}))

const bulkDeleteSessionsMock = jest.fn()
jest.mock("@/lib/db/sessions", () => ({
  bulkDeleteSessions: (ids: readonly string[]) => bulkDeleteSessionsMock(ids),
}))

const emitMock = jest.fn()
jest.mock("@/lib/plugin/messaging/message-bus", () => ({
  SystemEvents: { SESSION_DELETED: "system:session:deleted" },
  emitSystemBusEvent: (...args: unknown[]) => emitMock(...args),
}))

const isTauriMock = jest.fn()
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))

const chatState = {
  activeSessionId: null as string | null,
  setActiveSession: jest.fn(),
}
jest.mock("@/stores/chat", () => ({
  useChatStore: { getState: () => chatState },
}))

const disarmSessionMock = jest.fn()
jest.mock("@/stores/chat/im-notify-store", () => ({
  useImNotifyStore: { getState: () => ({ disarmSession: disarmSessionMock }) },
}))

import { SessionHandoffLockedError } from "@/lib/chat/session-write-guard"
import { deleteSessionsWithTeardown } from "./session-deletion"

beforeEach(() => {
  closeSessionMock.mockReset().mockResolvedValue(undefined)
  bulkDeleteSessionsMock.mockReset().mockResolvedValue(undefined)
  emitMock.mockReset()
  isTauriMock.mockReset().mockReturnValue(true)
  disarmSessionMock.mockReset()
  chatState.activeSessionId = null
  chatState.setActiveSession.mockReset()
})

describe("deleteSessionsWithTeardown", () => {
  it("closes each sidecar session, runs one cascade, then announces and deselects", async () => {
    chatState.activeSessionId = "s2"
    const order: string[] = []
    closeSessionMock.mockImplementation(async (id: string) => {
      order.push(`close:${id}`)
    })
    bulkDeleteSessionsMock.mockImplementation(async () => {
      order.push("cascade")
    })

    await deleteSessionsWithTeardown(["s1", "s2", "s1"])

    // Sidecar first, so a live run is not left writing into deleted rows.
    expect(order).toEqual(["close:s1", "close:s2", "cascade"])
    expect(bulkDeleteSessionsMock).toHaveBeenCalledWith(["s1", "s2"])
    expect(disarmSessionMock.mock.calls).toEqual([["s1"], ["s2"]])
    expect(emitMock).toHaveBeenCalledWith("system:session:deleted", { sessionId: "s1" })
    expect(emitMock).toHaveBeenCalledWith("system:session:deleted", { sessionId: "s2" })
    expect(chatState.setActiveSession).toHaveBeenCalledWith(null)
  })

  it("tolerates a sidecar that is not tracking the session", async () => {
    closeSessionMock.mockRejectedValueOnce(new Error("no such session"))
    await deleteSessionsWithTeardown(["s1"])
    expect(bulkDeleteSessionsMock).toHaveBeenCalledWith(["s1"])
  })

  it("skips the sidecar outside the desktop shell", async () => {
    isTauriMock.mockReturnValue(false)
    await deleteSessionsWithTeardown(["s1"])
    expect(closeSessionMock).not.toHaveBeenCalled()
    expect(bulkDeleteSessionsMock).toHaveBeenCalledWith(["s1"])
  })

  it("leaves another conversation selected", async () => {
    chatState.activeSessionId = "other"
    await deleteSessionsWithTeardown(["s1"])
    expect(chatState.setActiveSession).not.toHaveBeenCalled()
  })

  /**
   * The cascade checks the handoff lock before writing anything. A refusal must
   * reach the caller — the Host turns it into a rejected receipt — and nothing
   * may claim the conversation was deleted.
   */
  it("propagates a handoff-lock refusal without announcing a deletion", async () => {
    chatState.activeSessionId = "s1"
    bulkDeleteSessionsMock.mockRejectedValueOnce(
      new SessionHandoffLockedError("s1", "ticket-1", "delete")
    )
    await expect(deleteSessionsWithTeardown(["s1"])).rejects.toBeInstanceOf(
      SessionHandoffLockedError
    )
    expect(emitMock).not.toHaveBeenCalled()
    expect(disarmSessionMock).not.toHaveBeenCalled()
    expect(chatState.setActiveSession).not.toHaveBeenCalled()
  })

  it("does nothing for an empty selection", async () => {
    await deleteSessionsWithTeardown([])
    expect(closeSessionMock).not.toHaveBeenCalled()
    expect(bulkDeleteSessionsMock).not.toHaveBeenCalled()
  })
})
