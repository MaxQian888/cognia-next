/** @jest-environment jsdom */

import {
  NOTIFICATION_CENTER_REQUEST_EVENT,
  onNotificationCenterRequest,
  requestNotificationCenter,
} from "./center-request"

describe("notification center request seam", () => {
  const disposers: Array<() => void> = []

  afterEach(() => {
    // Return the module-level host count to 0 regardless of what a test did.
    while (disposers.length) disposers.pop()!()
  })

  const register = (handler: () => void) => {
    const dispose = onNotificationCenterRequest(handler)
    disposers.push(dispose)
    return dispose
  }

  it("uses a namespaced event name", () => {
    expect(NOTIFICATION_CENTER_REQUEST_EVENT).toBe("cognia:notification-center:request")
  })

  it("returns false and dispatches nothing when no host is mounted", () => {
    const listener = jest.fn()
    window.addEventListener(NOTIFICATION_CENTER_REQUEST_EVENT, listener)
    try {
      expect(requestNotificationCenter()).toBe(false)
      expect(listener).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(NOTIFICATION_CENTER_REQUEST_EVENT, listener)
    }
  })

  it("returns true and calls the handler when a host is mounted", () => {
    const handler = jest.fn()
    register(handler)
    expect(requestNotificationCenter()).toBe(true)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("calls every registered host", () => {
    const a = jest.fn()
    const b = jest.fn()
    register(a)
    register(b)
    expect(requestNotificationCenter()).toBe(true)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it("stops calling a host once it unregisters and reports false when none are left", () => {
    const handler = jest.fn()
    const dispose = register(handler)
    dispose()
    expect(requestNotificationCenter()).toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })

  it("keeps reporting true while at least one other host remains", () => {
    const a = jest.fn()
    const b = jest.fn()
    const disposeA = register(a)
    register(b)
    disposeA()
    expect(requestNotificationCenter()).toBe(true)
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
  })

  it("is safe to unregister twice and does not drop the host count below the live hosts", () => {
    const first = jest.fn()
    const second = jest.fn()
    const disposeFirst = register(first)
    register(second)

    disposeFirst()
    disposeFirst()

    // A double dispose must not have decremented the count for `second`.
    expect(requestNotificationCenter()).toBe(true)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it("returns the host count to zero after every host is disposed twice", () => {
    const disposers2 = [register(jest.fn()), register(jest.fn()), register(jest.fn())]
    for (const dispose of disposers2) {
      dispose()
      dispose()
    }
    expect(requestNotificationCenter()).toBe(false)
    // And a fresh host works again from zero.
    const handler = jest.fn()
    register(handler)
    expect(requestNotificationCenter()).toBe(true)
    expect(handler).toHaveBeenCalledTimes(1)
  })
})
