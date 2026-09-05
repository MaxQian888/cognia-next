import {
  ATTACH_LEASE_RENEW_INTERVAL_MS,
  ATTACH_LEASE_TTL_MS,
  RECENTLY_ACTIVE_WINDOW_MS,
  __resetDevicePresenceForTests,
  attachSessionLease,
  attachedDeviceIds,
  deviceEventStreams,
  devicePresence,
  effectiveController,
  eventPlaneState,
  hasControlLease,
  isSessionAttached,
  noteDeviceSeen,
  notifiableControllers,
  presenceLabel,
  readyEventStreamLeaseId,
  releaseDevice,
  releaseSessionLease,
  renewSessionLease,
  sessionLeases,
  setDeviceAttention,
  sweepExpiredLeases,
  syncEventStreams,
  type EventStreamConnection,
  type EventStreamState,
} from "./device-presence-registry"

const T0 = 1_000_000

beforeEach(() => {
  __resetDevicePresenceForTests()
})

afterEach(() => {
  __resetDevicePresenceForTests()
})

/** A stream exactly as the Host's Rust side reports it. */
function stream(
  leaseId: string,
  state: EventStreamState = "ready",
  transport: "ws" | "rtc" = "ws",
  openedAt = T0
): EventStreamConnection {
  return { leaseId, transport, state, openedAt }
}

/** Bring a device to the state a real client reaches after `stream_ready`. */
function connectReady(deviceId: string, leaseId = `esl_${deviceId}`, at = T0): string {
  syncEventStreams({ deviceId, streams: [stream(leaseId, "ready", "ws", at)], at })
  return leaseId
}

function control(deviceId: string, sessionId: string, leaseId: string, at = T0) {
  return attachSessionLease({
    sessionId,
    deviceId,
    mode: "control",
    eventStreamLeaseId: leaseId,
    at,
  })
}

describe("event streams", () => {
  it("derives the plane from the best stream the Host reported", () => {
    syncEventStreams({ deviceId: "d1", streams: [stream("a", "connecting")], at: T0 })
    expect(eventPlaneState("d1")).toBe("connecting")

    syncEventStreams({
      deviceId: "d1",
      streams: [stream("a", "connecting"), stream("b", "replaying", "rtc")],
      at: T0,
    })
    expect(eventPlaneState("d1")).toBe("replaying")

    // Best wins: a device with ANY caught-up stream can hear everything, so a
    // second socket mid-handshake must not drag it backwards.
    syncEventStreams({
      deviceId: "d1",
      streams: [stream("a", "connecting"), stream("b", "ready", "rtc")],
      at: T0,
    })
    expect(eventPlaneState("d1")).toBe("ready")

    syncEventStreams({ deviceId: "d1", streams: [], at: T0 })
    expect(eventPlaneState("d1")).toBe("disconnected")
  })

  it("closing one transport leaves the other serving", () => {
    syncEventStreams({
      deviceId: "d1",
      streams: [stream("ws-1", "ready", "ws"), stream("rtc-1", "ready", "rtc")],
      at: T0,
    })
    syncEventStreams({ deviceId: "d1", streams: [stream("rtc-1", "ready", "rtc")], at: T0 })
    expect(eventPlaneState("d1")).toBe("ready")
    expect(deviceEventStreams("d1")).toHaveLength(1)
    expect(devicePresence("d1")?.streams[0].transport).toBe("rtc")
  })

  /**
   * A dropped stream is usually a reconnect. The attachment must outlive it —
   * that is what the TTL is for — so the device gets its authority back without
   * a re-attach, and stays reachable by push while it is away.
   */
  it("keeps an attachment whose stream vanished, but strips its effectiveness", () => {
    syncEventStreams({ deviceId: "d1", streams: [stream("ws-1")], at: T0 })
    syncEventStreams({ deviceId: "d2", streams: [stream("rtc-1", "ready", "rtc")], at: T0 })
    control("d1", "s1", "ws-1")
    control("d2", "s1", "rtc-1")

    syncEventStreams({ deviceId: "d1", streams: [], at: T0 })
    expect(attachedDeviceIds("s1", T0)).toEqual(["d1", "d2"])
    expect(effectiveController("s1", T0)).toBe("d2")
    expect(isSessionAttached("s1", T0 + ATTACH_LEASE_TTL_MS)).toBe(false)
  })

  it("binds a controller to the oldest caught-up stream, ignoring a reconnect in progress", () => {
    syncEventStreams({
      deviceId: "d1",
      streams: [
        stream("old", "ready", "ws", T0),
        stream("new", "ready", "ws", T0 + 10),
        stream("half", "replaying", "rtc", T0 - 10),
      ],
      at: T0,
    })
    expect(readyEventStreamLeaseId("d1")).toBe("old")
  })

  it("reports no ready stream while every one of them is still catching up", () => {
    syncEventStreams({
      deviceId: "d1",
      streams: [stream("a", "connecting"), stream("b", "replaying")],
      at: T0,
    })
    expect(readyEventStreamLeaseId("d1")).toBeNull()
  })

  /**
   * `degraded` is the one state not read off a stream: no stream at all, but
   * the device kept making authenticated requests after losing it, for longer
   * than a renewal interval. A reconnect blip stays `disconnected`.
   */
  it("derives a degraded event plane from RPC outliving the streams", () => {
    for (const state of ["connecting", "replaying", "ready"] as const) {
      syncEventStreams({ deviceId: "d1", streams: [stream("a", state)], at: T0 })
      expect(eventPlaneState("d1", T0)).not.toBe("degraded")
    }
    syncEventStreams({ deviceId: "d1", streams: [], at: T0 })
    expect(eventPlaneState("d1", T0)).toBe("disconnected")
    // Still talking, but within the renewal window: a blip, not degradation.
    noteDeviceSeen("d1", T0 + 1_000)
    expect(eventPlaneState("d1", T0 + ATTACH_LEASE_RENEW_INTERVAL_MS)).toBe("disconnected")
    // Past the window with the RPC side still alive: degraded.
    expect(eventPlaneState("d1", T0 + ATTACH_LEASE_RENEW_INTERVAL_MS + 1)).toBe("degraded")
    expect(devicePresence("d1", T0 + ATTACH_LEASE_RENEW_INTERVAL_MS + 1)?.eventPlane).toBe(
      "degraded"
    )
    // A stream coming back clears it.
    connectReady("d1", "b", T0 + ATTACH_LEASE_RENEW_INTERVAL_MS + 2)
    expect(eventPlaneState("d1", T0 + ATTACH_LEASE_RENEW_INTERVAL_MS + 3)).toBe("ready")
  })

  it("stays disconnected when the device went silent along with its streams", () => {
    connectReady("d1")
    syncEventStreams({ deviceId: "d1", streams: [], at: T0 })
    expect(eventPlaneState("d1", T0 + ATTACH_LEASE_RENEW_INTERVAL_MS * 4)).toBe("disconnected")
  })
})

describe("attach leases", () => {
  it("refuses an attachment that names no live stream", () => {
    noteDeviceSeen("d1", T0)
    expect(() =>
      attachSessionLease({
        sessionId: "s1",
        deviceId: "d1",
        mode: "control",
        eventStreamLeaseId: "esl_bogus",
        at: T0,
      })
    ).toThrow("presence_attach_event_plane_required")
    expect(isSessionAttached("s1", T0)).toBe(false)
  })

  it("expires without renewal, and a lapsed lease cannot be renewed", () => {
    const lease = connectReady("d1")
    control("d1", "s1", lease)
    expect(isSessionAttached("s1", T0 + ATTACH_LEASE_TTL_MS - 1)).toBe(true)
    expect(isSessionAttached("s1", T0 + ATTACH_LEASE_TTL_MS)).toBe(false)

    expect(
      renewSessionLease({ sessionId: "s1", deviceId: "d1", at: T0 + ATTACH_LEASE_TTL_MS })
    ).toBe(null)
    expect(isSessionAttached("s1", T0 + 1)).toBe(true)
  })

  it("renewal extends the lease from the renewal instant", () => {
    const lease = connectReady("d1")
    control("d1", "s1", lease)
    const renewed = renewSessionLease({ sessionId: "s1", deviceId: "d1", at: T0 + 30_000 })
    expect(renewed?.expiresAt).toBe(T0 + 30_000 + ATTACH_LEASE_TTL_MS)
    expect(isSessionAttached("s1", T0 + ATTACH_LEASE_TTL_MS + 1)).toBe(true)
  })

  it("re-attaching preserves the original attach order", () => {
    const a = connectReady("d1", "c1")
    const b = connectReady("d2", "c2")
    control("d1", "s1", a, T0)
    control("d2", "s1", b, T0 + 10)
    control("d1", "s1", a, T0 + 20)
    expect(sessionLeases("s1", T0 + 20).map((l) => l.deviceId)).toEqual(["d1", "d2"])
  })

  it("sweeps lapsed leases and forgets the session once empty", () => {
    const lease = connectReady("d1")
    control("d1", "s1", lease)
    expect(sweepExpiredLeases(T0 + 1)).toBe(0)
    expect(sweepExpiredLeases(T0 + ATTACH_LEASE_TTL_MS)).toBe(1)
    expect(sessionLeases("s1", T0 + ATTACH_LEASE_TTL_MS)).toEqual([])
  })

  it("releasing a device clears every session it was watching", () => {
    const lease = connectReady("d1")
    control("d1", "s1", lease)
    control("d1", "s2", lease)
    releaseDevice("d1")
    expect(isSessionAttached("s1", T0)).toBe(false)
    expect(isSessionAttached("s2", T0)).toBe(false)
    expect(devicePresence("d1")).toBe(null)
  })

  it("releasing one session leaves the others attached", () => {
    const lease = connectReady("d1")
    control("d1", "s1", lease)
    control("d1", "s2", lease)
    releaseSessionLease("s1", "d1")
    expect(isSessionAttached("s1", T0)).toBe(false)
    expect(isSessionAttached("s2", T0)).toBe(true)
  })
})

describe("effectiveController", () => {
  it("an observer never holds control", () => {
    const lease = connectReady("d1")
    attachSessionLease({
      sessionId: "s1",
      deviceId: "d1",
      mode: "observe",
      eventStreamLeaseId: lease,
      at: T0,
    })
    expect(isSessionAttached("s1", T0)).toBe(true)
    expect(effectiveController("s1", T0)).toBe(null)
  })

  /**
   * The half-connected case. A device whose RPC channel works but whose event
   * stream is dead can still *send* — it just cannot hear what it is steering,
   * so it must not be treated as in control.
   */
  it("loses control the moment its event plane stops being ready, and regains it on reconnect", () => {
    const lease = connectReady("d1")
    control("d1", "s1", lease)
    expect(effectiveController("s1", T0)).toBe("d1")

    syncEventStreams({ deviceId: "d1", streams: [stream(lease, "replaying")], at: T0 + 1 })
    expect(effectiveController("s1", T0 + 1)).toBe(null)
    // The lease itself survives, so no re-attach is needed.
    expect(isSessionAttached("s1", T0 + 1)).toBe(true)

    syncEventStreams({ deviceId: "d1", streams: [stream(lease, "ready")], at: T0 + 2 })
    expect(effectiveController("s1", T0 + 2)).toBe("d1")
  })

  /**
   * The BOUND stream must be ready, not merely some stream of this device's.
   * A phone reconnecting holds a fresh caught-up socket beside the stale one
   * its attachment names — reading the device aggregate would hand control back
   * on the strength of a stream the attachment has nothing to do with.
   */
  it("does not accept a sibling stream in place of the one the lease named", () => {
    const lease = connectReady("d1")
    control("d1", "s1", lease)
    syncEventStreams({
      deviceId: "d1",
      streams: [stream(lease, "replaying"), stream("fresh", "ready", "rtc", T0 + 5)],
      at: T0 + 5,
    })
    expect(eventPlaneState("d1")).toBe("ready")
    expect(effectiveController("s1", T0 + 5)).toBe(null)
  })

  it("a control attachment cannot bind to a stream that has not caught up", () => {
    syncEventStreams({ deviceId: "d1", streams: [stream("slow", "replaying")], at: T0 })
    expect(() => control("d1", "s1", "slow")).toThrow("presence_attach_stream_not_ready")
    // An observer may bind to it — it is only being shown what happened.
    expect(() =>
      attachSessionLease({
        sessionId: "s1",
        deviceId: "d1",
        mode: "observe",
        eventStreamLeaseId: "slow",
        at: T0,
      })
    ).not.toThrow()
  })

  it("the earliest attachment wins so a second device cannot steal the wheel", () => {
    const a = connectReady("d1", "c1")
    const b = connectReady("d2", "c2")
    control("d1", "s1", a, T0)
    control("d2", "s1", b, T0 + 10)
    expect(effectiveController("s1", T0 + 10)).toBe("d1")
  })

  it("hands control to the next controller once the first lapses", () => {
    const a = connectReady("d1", "c1")
    const b = connectReady("d2", "c2")
    control("d1", "s1", a, T0)
    control("d2", "s1", b, T0 + 10)
    renewSessionLease({ sessionId: "s1", deviceId: "d2", at: T0 + 60_000 })
    expect(effectiveController("s1", T0 + ATTACH_LEASE_TTL_MS + 1)).toBe("d2")
  })
})

describe("notifiableControllers", () => {
  it("skips observers", () => {
    const lease = connectReady("d1")
    attachSessionLease({
      sessionId: "s1",
      deviceId: "d1",
      mode: "observe",
      eventStreamLeaseId: lease,
      at: T0,
    })
    setDeviceAttention("d1", "background", T0)
    expect(notifiableControllers("s1", T0)).toEqual([])
  })

  it("suppresses a foreground device that is already receiving the frame in-band", () => {
    const lease = connectReady("d1")
    control("d1", "s1", lease)
    setDeviceAttention("d1", "foreground", T0)
    expect(notifiableControllers("s1", T0)).toEqual([])
  })

  it("notifies a backgrounded controller even though its stream is healthy", () => {
    const lease = connectReady("d1")
    control("d1", "s1", lease)
    setDeviceAttention("d1", "background", T0)
    expect(notifiableControllers("s1", T0)).toEqual(["d1"])
  })

  /** A device mid-reconnect is precisely the one that cannot be reached in-band. */
  it("notifies a controller whose event stream dropped, even in the foreground", () => {
    const lease = connectReady("d1")
    control("d1", "s1", lease)
    setDeviceAttention("d1", "foreground", T0)
    syncEventStreams({ deviceId: "d1", streams: [], at: T0 + 1 })
    expect(notifiableControllers("s1", T0 + 1)).toEqual(["d1"])
  })

  it("never notifies a device whose lease already lapsed", () => {
    const lease = connectReady("d1")
    control("d1", "s1", lease)
    setDeviceAttention("d1", "background", T0)
    expect(notifiableControllers("s1", T0 + ATTACH_LEASE_TTL_MS)).toEqual([])
  })

  it("unknown attention is treated as not-in-band", () => {
    const lease = connectReady("d1")
    control("d1", "s1", lease)
    expect(devicePresence("d1")?.attention).toBe("unknown")
    expect(notifiableControllers("s1", T0)).toEqual(["d1"])
  })
})

describe("presenceLabel", () => {
  it("is online while a stream is open, recently-active within the window, then offline", () => {
    syncEventStreams({ deviceId: "d1", streams: [stream("c1", "connecting")], at: T0 })
    expect(presenceLabel("d1", T0)).toBe("online")

    syncEventStreams({ deviceId: "d1", streams: [], at: T0 })
    expect(presenceLabel("d1", T0 + RECENTLY_ACTIVE_WINDOW_MS)).toBe("recently-active")
    expect(presenceLabel("d1", T0 + RECENTLY_ACTIVE_WINDOW_MS + 1)).toBe("offline")
  })

  it("an unknown device is offline, not recently-active", () => {
    expect(presenceLabel("nobody", T0)).toBe("offline")
  })

  it("never moves lastSeenAt backwards", () => {
    noteDeviceSeen("d1", T0)
    noteDeviceSeen("d1", T0 - 5_000)
    expect(devicePresence("d1")?.lastSeenAt).toBe(T0)
  })
})

describe("hasControlLease", () => {
  /**
   * The approval router's question. It used to be "is anyone attached", which
   * was the same thing only because observe attachments could not exist. Now
   * they can, and holding a prompt open for a watcher who may not answer it
   * stalls the turn until the backstop denies.
   */
  it("ignores observers and survives a reconnecting controller", () => {
    const observer = connectReady("d-observer")
    attachSessionLease({
      sessionId: "s1",
      deviceId: "d-observer",
      mode: "observe",
      eventStreamLeaseId: observer,
      at: T0,
    })
    expect(isSessionAttached("s1", T0)).toBe(true)
    expect(hasControlLease("s1", T0)).toBe(false)

    const controller = connectReady("d-controller")
    control("d-controller", "s1", controller)
    expect(hasControlLease("s1", T0)).toBe(true)

    // Mid-reconnect the controller is not *effective*, but it is still the one
    // the prompt is for: auto-denying over a few seconds of churn is worse than
    // waiting for the frames to replay.
    syncEventStreams({ deviceId: "d-controller", streams: [], at: T0 + 1 })
    expect(effectiveController("s1", T0 + 1)).toBe(null)
    expect(hasControlLease("s1", T0 + 1)).toBe(true)
    // It only really loses the session by staying away for the whole lease.
    expect(hasControlLease("s1", T0 + ATTACH_LEASE_TTL_MS)).toBe(false)
  })

  it("goes false once the control lease lapses", () => {
    const lease = connectReady("d1")
    control("d1", "s1", lease)
    expect(hasControlLease("s1", T0 + ATTACH_LEASE_TTL_MS - 1)).toBe(true)
    expect(hasControlLease("s1", T0 + ATTACH_LEASE_TTL_MS)).toBe(false)
  })
})
