import {
  __resetRemoteAttachForTests,
  armApprovalBackstop,
  attachSession,
  attachedDeviceIds,
  clearApprovalBackstops,
  detachDevice,
  detachSession,
  hasArmedBackstop,
  isSessionAttached,
} from "./remote-attach-registry"

beforeEach(() => {
  __resetRemoteAttachForTests()
})

afterEach(() => {
  __resetRemoteAttachForTests()
})

describe("attach registry", () => {
  it("a fresh session is not attached", () => {
    expect(isSessionAttached("s1")).toBe(false)
    expect(attachedDeviceIds("s1")).toEqual([])
  })

  it("attachSession marks the session watched", () => {
    attachSession("s1", "dev-a")
    expect(isSessionAttached("s1")).toBe(true)
    expect(attachedDeviceIds("s1")).toEqual(["dev-a"])
  })

  it("ignores empty session or device ids", () => {
    attachSession("", "dev-a")
    attachSession("s1", "")
    expect(isSessionAttached("s1")).toBe(false)
  })

  it("refcounts by device — last watcher leaving detaches", () => {
    attachSession("s1", "dev-a")
    attachSession("s1", "dev-b")
    detachSession("s1", "dev-a")
    expect(isSessionAttached("s1")).toBe(true)
    detachSession("s1", "dev-b")
    expect(isSessionAttached("s1")).toBe(false)
  })

  it("attach is idempotent per device", () => {
    attachSession("s1", "dev-a")
    attachSession("s1", "dev-a")
    expect(attachedDeviceIds("s1")).toEqual(["dev-a"])
  })

  it("detachSession on an unknown session is a no-op", () => {
    expect(() => detachSession("nope", "dev-a")).not.toThrow()
    expect(isSessionAttached("nope")).toBe(false)
  })

  it("detachDevice drops the device from every session", () => {
    attachSession("s1", "dev-a")
    attachSession("s2", "dev-a")
    attachSession("s2", "dev-b")
    detachDevice("dev-a")
    expect(isSessionAttached("s1")).toBe(false)
    expect(isSessionAttached("s2")).toBe(true)
    expect(attachedDeviceIds("s2")).toEqual(["dev-b"])
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
