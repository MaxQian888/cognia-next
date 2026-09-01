const call = jest.fn(async (..._args: unknown[]): Promise<unknown> => [])
jest.mock("@/lib/tauri", () => ({
  transport: { call: (...args: unknown[]) => call(...args) },
  isTauri: () => true,
  isCapacitor: () => false,
}))
jest.mock("@/lib/platform/web-companion", () => ({ hasWebCompanionTarget: () => false }))
jest.mock("@/lib/tauri/transport-routing", () => ({ isRemoteHostActive: () => remoteHostActive }))

let remoteHostActive = false

import { registerLiveSession, unregisterLiveSession } from "./session-registry"
import {
  canControlSshForwards,
  readSshForwardStatus,
  setSshForwardEnabled,
  SSH_FORWARD_HOST_TOO_OLD,
  SSH_FORWARD_SESSION_UNREACHABLE,
  SSH_FORWARD_TOGGLE_LOCAL_ONLY,
  type SshForwardStatus,
} from "./ssh-forward-control"
import { __resetHostCapabilitiesForTests, recordProtocolFeatures } from "./host-capabilities"

function row(overrides: Partial<SshForwardStatus> = {}): SshForwardStatus {
  return {
    id: "lfwd-1",
    direction: "local",
    summary: "127.0.0.1:8080 → db.internal:5432",
    enabled: true,
    state: "listening",
    activeConnections: 2,
    queuedConnections: 0,
    error: null,
    ...overrides,
  }
}

beforeEach(() => {
  call.mockClear()
  call.mockResolvedValue([])
  remoteHostActive = false
  __resetHostCapabilitiesForTests()
})

describe("readSshForwardStatus", () => {
  it("asks the host for the named session and returns what it says", async () => {
    call.mockResolvedValue([row()])
    await expect(readSshForwardStatus("session-1")).resolves.toEqual([row()])
    expect(call).toHaveBeenCalledWith("ssh_terminal_forward_status", { id: "session-1" })
  })

  it("normalizes an empty error string to null so the UI has one falsy case", () => {
    call.mockResolvedValue([{ ...row(), error: "" }])
    return expect(readSshForwardStatus("session-1")).resolves.toEqual([row({ error: null })])
  })

  it("keeps a reported failure reason", async () => {
    call.mockResolvedValue([{ ...row(), state: "failed", error: "address already in use" }])
    const [rule] = await readSshForwardStatus("session-1")
    expect(rule.state).toBe("failed")
    expect(rule.error).toBe("address already in use")
  })

  it("treats a session with no forwards as an empty list, not an error", async () => {
    await expect(readSshForwardStatus("session-1")).resolves.toEqual([])
  })

  it("drops rows it cannot render rather than failing the whole read", async () => {
    // A future host could add a run state this build has no label for, and a
    // partial panel beats an error where three of four tunnels were fine.
    call.mockResolvedValue([
      row(),
      { ...row(), id: "unknown-state", state: "quantum" },
      { ...row(), id: "", direction: "local" },
      { ...row(), id: "bad-direction", direction: "sideways" },
      null,
      "nonsense",
    ])
    const rules = await readSshForwardStatus("session-1")
    expect(rules.map((rule) => rule.id)).toEqual(["lfwd-1"])
  })

  it("returns an empty list when the host answers with something that is not a list", async () => {
    call.mockResolvedValue({ forwards: [row()] })
    await expect(readSshForwardStatus("session-1")).resolves.toEqual([])
  })
})

describe("setSshForwardEnabled", () => {
  it("sends the toggle and renders the post-change snapshot it gets back", async () => {
    call.mockResolvedValue([row({ enabled: false, state: "stopped", activeConnections: 0 })])
    const rules = await setSshForwardEnabled("session-1", "lfwd-1", false)
    expect(call).toHaveBeenCalledWith("ssh_terminal_set_forward_enabled", {
      id: "session-1",
      forwardId: "lfwd-1",
      enabled: false,
    })
    // The reply is the state after the change, not an echo of the request, so
    // a rule that failed to bind reports `failed` here rather than `enabled`.
    expect(rules[0].enabled).toBe(false)
    expect(rules[0].state).toBe("stopped")
  })

  it("propagates a rejected toggle so the caller can show why", async () => {
    call.mockRejectedValue(new Error("unknown SSH forward lfwd-9"))
    await expect(setSshForwardEnabled("session-1", "lfwd-9", true)).rejects.toThrow("lfwd-9")
  })
})

describe("the remote path", () => {
  /**
   * A paired shell has no `ssh_terminal_*` — those are `target: "client"`. The
   * host has answered frames 24/25 the whole time, so these pin that the read
   * goes there and the write is refused before it costs a round trip.
   */
  function liveSession(sshForwardControl: jest.Mock) {
    return {
      id: "session-1",
      sshForwardControl,
      onInfo: undefined,
    } as unknown as Parameters<typeof registerLiveSession>[0]
  }

  afterEach(() => {
    unregisterLiveSession("session-1")
  })

  it("reads through the session's frames instead of the desktop-only RPC", async () => {
    remoteHostActive = true
    recordProtocolFeatures(["sshForwarding"])
    const control = jest.fn(async () => [row()])
    registerLiveSession(liveSession(control))

    await expect(readSshForwardStatus("session-1")).resolves.toEqual([row()])
    expect(control).toHaveBeenCalledWith({ kind: "status" })
    expect(call).not.toHaveBeenCalled()
  })

  it("names a host that never advertised the frames, rather than asking anyway", async () => {
    remoteHostActive = true
    recordProtocolFeatures(["flowControl"])
    const control = jest.fn(async () => [])
    registerLiveSession(liveSession(control))

    await expect(readSshForwardStatus("session-1")).rejects.toThrow(SSH_FORWARD_HOST_TOO_OLD)
    expect(control).not.toHaveBeenCalled()
  })

  it("names an unreachable session instead of throwing a transport error at the user", async () => {
    remoteHostActive = true
    recordProtocolFeatures(["sshForwarding"])
    await expect(readSshForwardStatus("session-1")).rejects.toThrow(SSH_FORWARD_SESSION_UNREACHABLE)
  })

  it("refuses the toggle locally, because the host would refuse it anyway", async () => {
    remoteHostActive = true
    recordProtocolFeatures(["sshForwarding"])
    const control = jest.fn(async () => [])
    registerLiveSession(liveSession(control))

    await expect(setSshForwardEnabled("session-1", "lfwd-1", false)).rejects.toThrow(
      SSH_FORWARD_TOGGLE_LOCAL_ONLY
    )
    expect(control).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalled()
  })

  it("reports which shell owns the SSH client", () => {
    expect(canControlSshForwards()).toBe(true)
    remoteHostActive = true
    expect(canControlSshForwards()).toBe(false)
  })
})
