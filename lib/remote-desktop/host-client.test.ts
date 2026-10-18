const callMock = jest.fn()
jest.mock("@/lib/tauri", () => ({
  transport: { call: (...args: unknown[]) => callMock(...args) },
}))

import {
  closeRemoteDesktopSession,
  deleteRemoteDesktopTarget,
  listRemoteDesktopTargets,
  openRemoteDesktopSession,
  probeRemoteDesktop,
  RemoteDesktopError,
  renewRemoteDesktopSession,
  saveRemoteDesktopTarget,
  setRemoteDesktopCredential,
  toRemoteDesktopError,
} from "./host-client"

beforeEach(() => callMock.mockReset())

describe("toRemoteDesktopError", () => {
  it("reads the Host code and detail out of a rejection", () => {
    const error = toRemoteDesktopError(new Error("remote_desktop_endpoint_unconfirmed: private"))
    expect(error).toBeInstanceOf(RemoteDesktopError)
    expect(error.code).toBe("remote_desktop_endpoint_unconfirmed")
    expect(error.detail).toBe("private")
    expect(toRemoteDesktopError("remote_desktop_session_limit").detail).toBeUndefined()
    expect(toRemoteDesktopError({ message: "remote_desktop_auth_failed: bad" }).code).toBe(
      "remote_desktop_auth_failed"
    )
  })

  it("maps anything else to unavailable, keeping the message as detail", () => {
    const error = toRemoteDesktopError(new Error("IPC channel closed"))
    expect(error.code).toBe("remote_desktop_unavailable")
    expect(error.detail).toBe("IPC channel closed")
    expect(toRemoteDesktopError(undefined).detail).toBeUndefined()
    const same = new RemoteDesktopError("remote_desktop_busy")
    expect(toRemoteDesktopError(same)).toBe(same)
  })
})

describe("host client", () => {
  it("walks every page of targets", async () => {
    callMock
      .mockResolvedValueOnce({ items: [{ id: "a" }], nextPageToken: "o:1" })
      .mockResolvedValueOnce({ items: [{ id: "b" }] })
    const targets = await listRemoteDesktopTargets()
    expect(targets.map((target) => target.id)).toEqual(["a", "b"])
    expect(callMock).toHaveBeenNthCalledWith(1, "remote_desktop_target_list", { pageSize: 100 })
    expect(callMock).toHaveBeenNthCalledWith(2, "remote_desktop_target_list", {
      pageSize: 100,
      pageToken: "o:1",
    })
  })

  it("names each command with the argument shape the Rust shells declare", async () => {
    callMock.mockResolvedValue({})
    const draft = { name: "NAS", bindings: [] }
    await saveRemoteDesktopTarget(draft)
    await deleteRemoteDesktopTarget("t")
    await setRemoteDesktopCredential("t", "b", "view", null)
    await probeRemoteDesktop({ kind: "saved", targetId: "t", bindingId: "b" })
    await openRemoteDesktopSession({
      targetId: "t",
      bindingId: "b",
      mode: "control",
      takeover: true,
    })
    await renewRemoteDesktopSession("s")
    await closeRemoteDesktopSession("s")
    expect(callMock.mock.calls).toEqual([
      ["remote_desktop_target_save", { draft }],
      ["remote_desktop_target_delete", { targetId: "t" }],
      [
        "remote_desktop_credential_set",
        { targetId: "t", bindingId: "b", kind: "view", value: null },
      ],
      [
        "remote_desktop_target_probe",
        { request: { kind: "saved", targetId: "t", bindingId: "b" } },
      ],
      [
        "remote_desktop_session_open",
        { targetId: "t", bindingId: "b", mode: "control", takeover: true },
      ],
      ["remote_desktop_session_renew", { sessionId: "s" }],
      ["remote_desktop_session_close", { sessionId: "s" }],
    ])
  })

  it("rejects with a typed Host refusal", async () => {
    callMock.mockRejectedValue(new Error("remote_desktop_control_busy"))
    await expect(
      openRemoteDesktopSession({ targetId: "t", bindingId: "b", mode: "control", takeover: false })
    ).rejects.toMatchObject({ code: "remote_desktop_control_busy" })
  })
})
