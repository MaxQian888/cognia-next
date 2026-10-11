const invokeMock = jest.fn()
jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

const isTauriMock = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))

const setAutostartMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/tauri/autostart", () => ({
  setAutostart: (...args: unknown[]) => setAutostartMock(...args),
}))

const setCloseBehaviorMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/tauri/close-behavior", () => ({
  setCloseBehavior: (...args: unknown[]) => setCloseBehaviorMock(...args),
}))

import {
  HOST_MODE_OFF,
  __resetHostModeForTests,
  hostModeLoaded,
  readHostMode,
  refreshHostMode,
  setHostMode,
  subscribeHostMode,
} from "./host-mode"

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
  __resetHostModeForTests()
})

describe("refreshHostMode", () => {
  it("reads the status from Rust and publishes it", async () => {
    invokeMock.mockResolvedValueOnce({ enabled: true, bootHidden: true })
    const listener = jest.fn()
    subscribeHostMode(listener)
    expect(readHostMode()).toEqual(HOST_MODE_OFF)
    expect(hostModeLoaded()).toBe(false)
    await expect(refreshHostMode()).resolves.toEqual({ enabled: true, bootHidden: true })
    expect(invokeMock).toHaveBeenCalledWith("host_mode_get")
    expect(readHostMode()).toEqual({ enabled: true, bootHidden: true })
    expect(hostModeLoaded()).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("shares one request between concurrent callers", async () => {
    invokeMock.mockResolvedValueOnce({ enabled: false, bootHidden: false })
    await Promise.all([refreshHostMode(), refreshHostMode()])
    expect(invokeMock).toHaveBeenCalledTimes(1)
  })

  it("announces the first read even when it is off, then only changes", async () => {
    invokeMock.mockResolvedValue({ enabled: false, bootHidden: false })
    const listener = jest.fn()
    subscribeHostMode(listener)
    await refreshHostMode()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(hostModeLoaded()).toBe(true)
    await refreshHostMode()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("reads as off outside the desktop shell without calling Rust", async () => {
    isTauriMock.mockReturnValue(false)
    await expect(refreshHostMode()).resolves.toEqual(HOST_MODE_OFF)
    expect(invokeMock).not.toHaveBeenCalled()
  })
})

describe("setHostMode", () => {
  it("turning it on also registers launch at login and closes to the tray", async () => {
    invokeMock.mockResolvedValueOnce({ enabled: true, bootHidden: false })
    await expect(setHostMode(true)).resolves.toEqual({ enabled: true, bootHidden: false })
    expect(invokeMock).toHaveBeenCalledWith("host_mode_set", { enabled: true })
    expect(setAutostartMock).toHaveBeenCalledWith(true)
    expect(setCloseBehaviorMock).toHaveBeenCalledWith("tray")
    expect(readHostMode().enabled).toBe(true)
  })

  it("turning it off leaves launch at login and the close button alone", async () => {
    invokeMock.mockResolvedValueOnce({ enabled: false, bootHidden: false })
    await setHostMode(false)
    expect(invokeMock).toHaveBeenCalledWith("host_mode_set", { enabled: false })
    expect(setAutostartMock).not.toHaveBeenCalled()
    expect(setCloseBehaviorMock).not.toHaveBeenCalled()
  })

  it("does not touch autostart when Rust could not persist the mode", async () => {
    invokeMock.mockRejectedValueOnce("could not save host mode")
    await expect(setHostMode(true)).rejects.toBe("could not save host mode")
    expect(setAutostartMock).not.toHaveBeenCalled()
    expect(readHostMode()).toEqual(HOST_MODE_OFF)
  })

  it("is a no-op outside the desktop shell", async () => {
    isTauriMock.mockReturnValue(false)
    await expect(setHostMode(true)).resolves.toEqual(HOST_MODE_OFF)
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
