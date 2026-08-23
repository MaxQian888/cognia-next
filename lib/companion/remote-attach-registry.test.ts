import {
  __resetRemoteAttachForTests,
  approvalPushTargets,
  armApprovalBackstop,
  attachSession,
  attachedDeviceIds,
  clearApprovalBackstops,
  detachDevice,
  detachSession,
  hasArmedBackstop,
  isSessionAttached,
} from "./remote-attach-registry"
import {
  ATTACH_LEASE_TTL_MS,
  setDeviceAttention,
  type EventStreamConnection,
  type EventStreamState,
} from "./device-presence-registry"
import { REMOTE_CONTROL_CAPABILITY } from "./remote-attach-registry"

const T0 = 1_000_000

/** Grants a device holds after the desktop's remote-control toggle is on. */
const CONTROL_GRANTS = ["host.observe", "agent.run", "workspace.read", REMOTE_CONTROL_CAPABILITY]
/** What `insert_default_grants` gives every freshly paired member device. */
const DEFAULT_GRANTS = ["host.observe", "agent.run", "workspace.read"]

function streams(state: EventStreamState = "ready", at = T0): EventStreamConnection[] {
  return [{ leaseId: `esl_${state}`, transport: "ws", state, openedAt: at }]
}

/** The ordinary case: a granted device whose stream Rust reported as caught up. */
function attachLive(sessionId: string, deviceId: string, now = T0) {
  return attachSession(sessionId, deviceId, {
    eventStreams: streams("ready", now),
    grants: CONTROL_GRANTS,
    now,
  }).mode
}

beforeEach(() => {
  __resetRemoteAttachForTests()
})

afterEach(() => {
  __resetRemoteAttachForTests()
})

describe("attach registry", () => {
  it("a fresh session is not attached", () => {
    expect(isSessionAttached("s1", T0)).toBe(false)
    expect(attachedDeviceIds("s1", T0)).toEqual([])
  })

  it("attachSession marks the session watched", () => {
    expect(attachLive("s1", "dev-a")).toBe("control")
    expect(isSessionAttached("s1", T0)).toBe(true)
    expect(attachedDeviceIds("s1", T0)).toEqual(["dev-a"])
  })

  it("ignores empty session or device ids", () => {
    expect(() => attachLive("", "dev-a")).toThrow()
    expect(() => attachLive("s1", "")).toThrow()
    expect(isSessionAttached("s1", T0)).toBe(false)
  })

  it("refcounts by device — last watcher leaving detaches", () => {
    attachLive("s1", "dev-a")
    attachLive("s1", "dev-b")
    detachSession("s1", "dev-a")
    expect(isSessionAttached("s1", T0)).toBe(true)
    detachSession("s1", "dev-b")
    expect(isSessionAttached("s1", T0)).toBe(false)
  })

  it("attach is idempotent per device", () => {
    attachLive("s1", "dev-a")
    attachLive("s1", "dev-a")
    expect(attachedDeviceIds("s1", T0)).toEqual(["dev-a"])
  })

  it("detachSession on an unknown session is a no-op", () => {
    expect(() => detachSession("nope", "dev-a")).not.toThrow()
    expect(isSessionAttached("nope", T0)).toBe(false)
  })

  it("detachDevice drops the device from every session", () => {
    attachLive("s1", "dev-a")
    attachLive("s2", "dev-a")
    attachLive("s2", "dev-b")
    detachDevice("dev-a")
    expect(isSessionAttached("s1", T0)).toBe(false)
    expect(isSessionAttached("s2", T0)).toBe(true)
    expect(attachedDeviceIds("s2", T0)).toEqual(["dev-b"])
  })

  /**
   * The leak this registry was rewritten to close. A phone that dropped its
   * socket without detaching used to stay attached forever, so the host kept
   * routing approvals to it and every one of them ran out the 120s backstop.
   */
  it("an attachment lapses when nobody renews it", () => {
    attachLive("s1", "dev-a")
    expect(isSessionAttached("s1", T0 + ATTACH_LEASE_TTL_MS - 1)).toBe(true)
    expect(isSessionAttached("s1", T0 + ATTACH_LEASE_TTL_MS)).toBe(false)
  })

  it("re-attaching renews the lease", () => {
    attachLive("s1", "dev-a", T0)
    attachLive("s1", "dev-a", T0 + 30_000)
    expect(isSessionAttached("s1", T0 + ATTACH_LEASE_TTL_MS + 1)).toBe(true)
  })

  /**
   * A device that can answer RPCs but whose event stream is still replaying
   * cannot have seen the `permission_request` frame its approval would refer
   * to, so it attaches as an observer and is never handed a decision.
   */
  it("attaches as an observer while its event stream is still catching up", () => {
    const result = attachSession("s1", "dev-a", {
      eventStreams: streams("replaying"),
      grants: CONTROL_GRANTS,
      now: T0,
    })
    expect(result).toMatchObject({
      mode: "observe",
      downgradeReason: "event-plane-not-ready",
      eventPlane: "replaying",
    })
    // Still watching — but not somebody a decision can be routed to.
    expect(attachedDeviceIds("s1", T0)).toEqual(["dev-a"])
    expect(isSessionAttached("s1", T0)).toBe(false)
    expect(approvalPushTargets("s1", T0)).toEqual([])
  })

  /**
   * The grant that must NOT be mistaken for remote control. Every freshly
   * paired member device gets `agent.run` from `insert_default_grants`, so
   * keying control off it would hand the wheel to every phone that pairs.
   */
  it("refuses control to a default-granted device that never got Remote Control", () => {
    const result = attachSession("s1", "dev-a", {
      eventStreams: streams("ready"),
      grants: DEFAULT_GRANTS,
      now: T0,
    })
    expect(result).toMatchObject({ mode: "observe", downgradeReason: "missing-capability" })
    expect(isSessionAttached("s1", T0)).toBe(false)
  })

  it("honours an explicit observe request from a device that could have controlled", () => {
    const result = attachSession("s1", "dev-a", {
      requestedMode: "observe",
      eventStreams: streams("ready"),
      grants: CONTROL_GRANTS,
      now: T0,
    })
    expect(result).toMatchObject({ mode: "observe", downgradeReason: null })
    expect(attachedDeviceIds("s1", T0)).toEqual(["dev-a"])
    expect(isSessionAttached("s1", T0)).toBe(false)
  })

  /**
   * A renewal arriving while the stream reconnects must not demote a
   * controller: the whole point of the TTL is surviving churn. Losing the
   * capability is not churn and still demotes at once.
   */
  it("keeps a controller through a reconnect but not through a revoked grant", () => {
    expect(attachLive("s1", "dev-a")).toBe("control")

    const midReconnect = attachSession("s1", "dev-a", {
      eventStreams: [],
      grants: CONTROL_GRANTS,
      now: T0 + 30_000,
    })
    expect(midReconnect).toMatchObject({ mode: "control", eventPlane: "disconnected" })
    expect(isSessionAttached("s1", T0 + 30_000)).toBe(true)

    const revoked = attachSession("s1", "dev-a", {
      eventStreams: [],
      grants: DEFAULT_GRANTS,
      now: T0 + 40_000,
    })
    expect(revoked).toMatchObject({ mode: "observe", downgradeReason: "missing-capability" })
    expect(isSessionAttached("s1", T0 + 40_000)).toBe(false)
  })

  it("holds no attachment at all for a device with no event stream", () => {
    const result = attachSession("s1", "dev-a", {
      eventStreams: [],
      grants: DEFAULT_GRANTS,
      now: T0,
    })
    expect(result.mode).toBe("observe")
    expect(attachedDeviceIds("s1", T0)).toEqual([])
  })
})

describe("approvalPushTargets", () => {
  it("names the attached controller when it is not already watching", () => {
    attachLive("s1", "dev-a")
    setDeviceAttention("dev-a", "background", T0)
    expect(approvalPushTargets("s1", T0)).toEqual(["dev-a"])
  })

  it("stays empty for a foreground controller that already has the frame", () => {
    attachLive("s1", "dev-a")
    setDeviceAttention("dev-a", "foreground", T0)
    expect(approvalPushTargets("s1", T0)).toEqual([])
  })

  it("stays empty once the attachment lapses", () => {
    attachLive("s1", "dev-a")
    setDeviceAttention("dev-a", "background", T0)
    expect(approvalPushTargets("s1", T0 + ATTACH_LEASE_TTL_MS)).toEqual([])
  })
})

describe("approval backstop", () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it("fires onTimeout after the window when not cleared", () => {
    const onTimeout = jest.fn()
    armApprovalBackstop("s1", "req-1", onTimeout, 1000)
    expect(hasArmedBackstop("s1")).toBe(true)
    jest.advanceTimersByTime(999)
    expect(onTimeout).not.toHaveBeenCalled()
    jest.advanceTimersByTime(1)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(hasArmedBackstop("s1")).toBe(false)
  })

  it("clearApprovalBackstops cancels a pending deny (remote approved)", () => {
    const onTimeout = jest.fn()
    armApprovalBackstop("s1", "req-1", onTimeout, 1000)
    clearApprovalBackstops("s1")
    expect(hasArmedBackstop("s1")).toBe(false)
    jest.advanceTimersByTime(5000)
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it("re-arming the same request replaces the prior timer", () => {
    const first = jest.fn()
    const second = jest.fn()
    armApprovalBackstop("s1", "req-1", first, 1000)
    armApprovalBackstop("s1", "req-1", second, 1000)
    jest.advanceTimersByTime(1000)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it("tracks independent backstops per request within a session", () => {
    const a = jest.fn()
    const b = jest.fn()
    armApprovalBackstop("s1", "req-a", a, 1000)
    armApprovalBackstop("s1", "req-b", b, 2000)
    jest.advanceTimersByTime(1000)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
    expect(hasArmedBackstop("s1")).toBe(true)
    jest.advanceTimersByTime(1000)
    expect(b).toHaveBeenCalledTimes(1)
    expect(hasArmedBackstop("s1")).toBe(false)
  })
})
