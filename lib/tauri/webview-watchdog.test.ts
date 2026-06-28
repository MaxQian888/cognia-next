import {
  __resetWebviewHeartbeatForTests,
  HEARTBEAT_INTERVAL_MS,
  startWebviewHeartbeat,
  takeWhiteScreenRecoveryNotice,
} from "./webview-watchdog"

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))

import { invoke } from "@tauri-apps/api/core"

const mockedInvoke = invoke as jest.MockedFunction<typeof invoke>

const TAURI_KEY = "__TAURI_INTERNALS__"

function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>)[TAURI_KEY] = {}
  else delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
}

describe("lib/tauri/webview-watchdog", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useRealTimers()
    __resetWebviewHeartbeatForTests()
    setTauri(false)
    mockedInvoke.mockResolvedValue(undefined)
  })

  afterEach(() => {
    setTauri(false)
  })

  describe("startWebviewHeartbeat", () => {
    it("no-ops off Tauri", () => {
      startWebviewHeartbeat()
      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it("beats immediately and on the interval under Tauri", () => {
      jest.useFakeTimers()
      setTauri(true)

      startWebviewHeartbeat()
      expect(mockedInvoke).toHaveBeenCalledTimes(1)
      expect(mockedInvoke).toHaveBeenLastCalledWith("webview_heartbeat", {
        url: window.location.href,
      })

      jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS)
      expect(mockedInvoke).toHaveBeenCalledTimes(2)

      jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2)
      expect(mockedInvoke).toHaveBeenCalledTimes(4)
    })

    it("is idempotent — a second call does not install a second interval", () => {
      jest.useFakeTimers()
      setTauri(true)
      startWebviewHeartbeat()
      startWebviewHeartbeat()
      // Two starts would otherwise double the beats per tick.
      mockedInvoke.mockClear()
      jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS)
      expect(mockedInvoke).toHaveBeenCalledTimes(1)
    })

    it("swallows heartbeat IPC failures", () => {
      jest.useFakeTimers()
      setTauri(true)
      mockedInvoke.mockRejectedValue(new Error("ipc gone"))
      expect(() => startWebviewHeartbeat()).not.toThrow()
    })
  })

  describe("takeWhiteScreenRecoveryNotice", () => {
    it("returns false off Tauri without calling invoke", async () => {
      await expect(takeWhiteScreenRecoveryNotice()).resolves.toBe(false)
      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it("returns the Rust flag under Tauri", async () => {
      setTauri(true)
      mockedInvoke.mockResolvedValue(true)
      await expect(takeWhiteScreenRecoveryNotice()).resolves.toBe(true)
      expect(mockedInvoke).toHaveBeenCalledWith("webview_take_recovery_notice")
    })

    it("returns false when the command throws", async () => {
      setTauri(true)
      mockedInvoke.mockRejectedValue(new Error("nope"))
      await expect(takeWhiteScreenRecoveryNotice()).resolves.toBe(false)
    })
  })
})
