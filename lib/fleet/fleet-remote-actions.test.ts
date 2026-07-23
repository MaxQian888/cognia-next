const callMock = jest.fn()
jest.mock("@/lib/tauri", () => ({
  transport: { call: (...args: unknown[]) => callMock(...args), subscribe: jest.fn() },
  isTauri: () => false,
  invoke: jest.fn(),
}))

import {
  fleetRemoteFocusTerminal,
  fleetRemoteGetSnapshot,
  fleetRemoteInterrupt,
  fleetRemotePermissionRespond,
  fleetRemoteQuestionRespond,
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

  it("answers an AskUserQuestion with option indices", async () => {
    // Indices, not labels: the snapshot truncates long option text for display,
    // so a label-keyed answer would never match the agent's real options.
    callMock.mockResolvedValue(true)
    await expect(fleetRemoteQuestionRespond("q-1", [[2], [0, 1]])).resolves.toBe(true)
    expect(callMock).toHaveBeenCalledWith("fleet_question_respond", {
      requestId: "q-1",
      selections: [[2], [0, 1]],
    })
  })

  it("reports a lapsed answer window rather than throwing", async () => {
    callMock.mockResolvedValue(false)
    await expect(fleetRemoteQuestionRespond("q-1", [[0]])).resolves.toBe(false)
  })

  it("interrupts a session over the transport", async () => {
    callMock.mockResolvedValue(null)
    await expect(fleetRemoteInterrupt("claude-code", "s1")).resolves.toBeUndefined()
    expect(callMock).toHaveBeenCalledWith("fleet_interrupt_session", {
      agent: "claude-code",
      sessionId: "s1",
    })
  })

  it("propagates an interrupt refusal so the caller can classify it", async () => {
    // Refusals (dead pid, recycled pid, unsupported platform) must reach the
    // caller — silently swallowing them would look like a successful interrupt.
    callMock.mockRejectedValue(new Error("interrupt_identity_mismatch"))
    await expect(fleetRemoteInterrupt("claude-code", "s1")).rejects.toThrow(
      "interrupt_identity_mismatch"
    )
  })

  it("classifies the remote-control-forbidden error", () => {
    expect(isControlForbidden({ code: "remote_control_forbidden" })).toBe(true)
    expect(isControlForbidden({ status: 403 })).toBe(true)
    expect(isControlForbidden(new Error("boom: remote_control_forbidden here"))).toBe(true)
    expect(isControlForbidden({ code: "network" })).toBe(false)
    expect(isControlForbidden(null)).toBe(false)
  })
})
