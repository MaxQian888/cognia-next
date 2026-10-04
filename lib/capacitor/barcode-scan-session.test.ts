import {
  getBarcodeScanSnapshot,
  openBarcodeScanView,
  registerBarcodeScanHost,
  subscribeBarcodeScanView,
  waitForBarcodeScanViewHost,
} from "./barcode-scan-session"

describe("native barcode scan view session", () => {
  it("waits for the dynamically loaded host and resolves immediately once ready", async () => {
    let ready = false
    const waiting = waitForBarcodeScanViewHost().then(() => {
      ready = true
    })
    await Promise.resolve()
    expect(ready).toBe(false)
    const unregister = registerBarcodeScanHost()
    await waiting
    expect(ready).toBe(true)
    await expect(waitForBarcodeScanViewHost()).resolves.toBeUndefined()
    unregister()
  })

  it("cancels pending and already-aborted readiness waits", async () => {
    const controller = new AbortController()
    const waiting = waitForBarcodeScanViewHost(controller.signal)
    controller.abort()
    await expect(waiting).rejects.toThrow("cancelled")
    await expect(waitForBarcodeScanViewHost(controller.signal)).rejects.toThrow("cancelled")
    const unregister = registerBarcodeScanHost()
    unregister()
  })
  it("requires a mounted host before opening the camera UI", () => {
    expect(() => openBarcodeScanView({ onCancel: jest.fn() })).toThrow("not mounted")
  })

  it("allows only one scan and publishes stable snapshots until state changes", () => {
    const unregister = registerBarcodeScanHost()
    const notify = jest.fn()
    const unsubscribe = subscribeBarcodeScanView(notify)
    const view = openBarcodeScanView({ onCancel: jest.fn() })
    const snapshot = getBarcodeScanSnapshot()
    expect(getBarcodeScanSnapshot()).toBe(snapshot)
    expect(() => openBarcodeScanView({ onCancel: jest.fn() })).toThrow("already open")
    view.setTorch(true)
    expect(getBarcodeScanSnapshot()?.torchEnabled).toBe(true)
    view.close()
    view.close()
    expect(getBarcodeScanSnapshot()).toBeNull()
    expect(notify).toHaveBeenCalledTimes(3)
    unsubscribe()
    unregister()
  })

  it("cancels once and closes when the final host unmounts", () => {
    const first = registerBarcodeScanHost()
    const second = registerBarcodeScanHost()
    const onCancel = jest.fn()
    openBarcodeScanView({ onCancel })
    first()
    expect(onCancel).not.toHaveBeenCalled()
    second()
    second()
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(getBarcodeScanSnapshot()).toBeNull()
  })

  it("ignores updates and closes from a finished session", () => {
    const unregister = registerBarcodeScanHost()
    const old = openBarcodeScanView({ onCancel: jest.fn() })
    old.close()
    const current = openBarcodeScanView({ onCancel: jest.fn() })
    old.setTorch(true)
    old.close()
    expect(getBarcodeScanSnapshot()?.torchEnabled).toBe(false)
    current.close()
    unregister()
  })

  it("serializes torch toggles and contains a rejected native request", async () => {
    const unregister = registerBarcodeScanHost()
    const onToggleTorch = jest.fn(async () => {
      throw new Error("torch unavailable")
    })
    const view = openBarcodeScanView({ onCancel: jest.fn(), onToggleTorch })
    getBarcodeScanSnapshot()?.toggleTorch?.()
    getBarcodeScanSnapshot()?.toggleTorch?.()
    expect(onToggleTorch).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    await Promise.resolve()
    expect(getBarcodeScanSnapshot()?.torchError).toBe(true)
    expect(getBarcodeScanSnapshot()?.torchPending).toBe(false)
    view.close()
    unregister()
  })
})
