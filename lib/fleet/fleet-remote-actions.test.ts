const callMock = jest.fn()
jest.mock("@/lib/tauri", () => ({
  transport: { call: (...args: unknown[]) => callMock(...args), subscribe: jest.fn() },
  isTauri: () => false,
  invoke: jest.fn(),
}))

import {
  fleetRemoteFocusTerminal,
  fleetRemoteGetSnapshot,
  fleetRemotePermissionRespond,
  fleetRemoteSendMessage,
  isControlForbidden,
} from "./fleet-remote-actions"

describe("fleet-remote-actions", () => {
  beforeEach(() => callMock.mockReset())

  it("fetches the snapshot via fleet_get_snapshot", async () => {
    const snap = { sessions: [{ sessionId: "s" }], generatedAt: 5 }
    callMock.mockResolvedValue(snap)
    await expect(fleetRemoteGetSnapshot()).resolves.toEqual(snap)
    expect(callMock).toHaveBeenCalledWith("fleet_get_snapshot")
  })

  it("degrades a failed snapshot read to empty", async () => {
    callMock.mockRejectedValue(new Error("offline"))
    await expect(fleetRemoteGetSnapshot()).resolves.toEqual({ sessions: [], generatedAt: 0 })
  })

  it("maps permission / send / focus to their commands and args", async () => {
    callMock.mockResolvedValue(true)
    await fleetRemotePermissionRespond("req-1", "allow")
    expect(callMock).toHaveBeenCalledWith("fleet_permission_respond", {
      requestId: "req-1",
      behavior: "allow",
    })

    callMock.mockResolvedValue("cmd-9")
    await expect(fleetRemoteSendMessage("s1", "go")).resolves.toBe("cmd-9")
    expect(callMock).toHaveBeenCalledWith("fleet_opencode_send_message", {
      sessionId: "s1",
      text: "go",
    })

    callMock.mockResolvedValue(null)
    await fleetRemoteFocusTerminal("claude-code", "s1")
    expect(callMock).toHaveBeenCalledWith("fleet_focus_terminal", {
      agent: "claude-code",
      sessionId: "s1",
    })
  })

  it("propagates a rejection from a control action", async () => {
    callMock.mockRejectedValue({ code: "remote_control_forbidden" })
    await expect(fleetRemotePermissionRespond("r", "deny")).rejects.toEqual({
      code: "remote_control_forbidden",
    })
  })

  it("classifies the remote-control-forbidden error", () => {
    expect(isControlForbidden({ code: "remote_control_forbidden" })).toBe(true)
    expect(isControlForbidden({ status: 403 })).toBe(true)
    expect(isControlForbidden(new Error("boom: remote_control_forbidden here"))).toBe(true)
    expect(isControlForbidden({ code: "network" })).toBe(false)
    expect(isControlForbidden(null)).toBe(false)
  })
})
