/** @jest-environment jsdom */
import { checkNotificationPermission, ensureNotificationPermission, notify } from "./notification"

jest.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: jest.fn(),
  requestPermission: jest.fn(),
  sendNotification: jest.fn(),
}))

import {
  isPermissionGranted,
  requestPermission,
  sendNotification as sendNative,
} from "@tauri-apps/plugin-notification"

const mockedIsGranted = isPermissionGranted as jest.MockedFunction<typeof isPermissionGranted>
const mockedRequest = requestPermission as jest.MockedFunction<typeof requestPermission>
const mockedSend = sendNative as jest.MockedFunction<typeof sendNative>

const TAURI_KEY = "__TAURI_INTERNALS__"

function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>)[TAURI_KEY] = {}
  else delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
}

describe("lib/tauri/notification", () => {
  let warnSpy: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    setTauri(false)
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    setTauri(false)
    warnSpy.mockRestore()
  })

  describe("ensureNotificationPermission", () => {
    it("returns 'denied' outside Tauri", async () => {
      await expect(ensureNotificationPermission()).resolves.toBe("denied")
      expect(mockedIsGranted).not.toHaveBeenCalled()
      expect(mockedRequest).not.toHaveBeenCalled()
    })

    it("returns 'granted' immediately when already granted", async () => {
      setTauri(true)
      mockedIsGranted.mockResolvedValue(true)
      await expect(ensureNotificationPermission()).resolves.toBe("granted")
      expect(mockedRequest).not.toHaveBeenCalled()
    })

    it("requests permission and returns the result when not granted", async () => {
      setTauri(true)
      mockedIsGranted.mockResolvedValue(false)
      mockedRequest.mockResolvedValue("granted")
      await expect(ensureNotificationPermission()).resolves.toBe("granted")
      expect(mockedRequest).toHaveBeenCalledTimes(1)
    })

    it("returns 'denied' from request when user rejects", async () => {
      setTauri(true)
      mockedIsGranted.mockResolvedValue(false)
      mockedRequest.mockResolvedValue("denied")
      await expect(ensureNotificationPermission()).resolves.toBe("denied")
    })

    it("logs and returns 'default' when isPermissionGranted throws", async () => {
      setTauri(true)
      mockedIsGranted.mockRejectedValue(new Error("perm boom"))
      await expect(ensureNotificationPermission()).resolves.toBe("default")
      expect(warnSpy).toHaveBeenCalledWith("ensureNotificationPermission failed", expect.any(Error))
    })

    it("logs and returns 'default' when requestPermission throws", async () => {
      setTauri(true)
      mockedIsGranted.mockResolvedValue(false)
      mockedRequest.mockRejectedValue(new Error("req boom"))
      await expect(ensureNotificationPermission()).resolves.toBe("default")
    })
  })

  describe("checkNotificationPermission", () => {
    it("returns denied outside Tauri", async () => {
      await expect(checkNotificationPermission()).resolves.toBe("denied")
      expect(mockedIsGranted).not.toHaveBeenCalled()
    })

    it("reflects an existing grant", async () => {
      setTauri(true)
      mockedIsGranted.mockResolvedValue(true)
      await expect(checkNotificationPermission()).resolves.toBe("granted")
    })

    it("checks an existing grant without opening the OS prompt", async () => {
      setTauri(true)
      mockedIsGranted.mockResolvedValue(false)

      await expect(checkNotificationPermission()).resolves.toBe("default")

      expect(mockedIsGranted).toHaveBeenCalledTimes(1)
      expect(mockedRequest).not.toHaveBeenCalled()
    })

    it("logs and falls back to default when the check fails", async () => {
      setTauri(true)
      mockedIsGranted.mockRejectedValue(new Error("check boom"))
      await expect(checkNotificationPermission()).resolves.toBe("default")
      expect(warnSpy).toHaveBeenCalledWith("checkNotificationPermission failed", expect.any(Error))
    })
  })

  describe("notify", () => {
    it("is a no-op outside Tauri", async () => {
      await notify("hi")
      expect(mockedSend).not.toHaveBeenCalled()
    })

    it("calls sendNotification with a string in Tauri", async () => {
      setTauri(true)
      await notify("hello")
      expect(mockedSend).toHaveBeenCalledWith("hello")
    })

    it("calls sendNotification with an Options object in Tauri", async () => {
      setTauri(true)
      const opts = { title: "T", body: "B" }
      await notify(opts)
      expect(mockedSend).toHaveBeenCalledWith(opts)
    })

    it("logs and swallows errors from sendNotification", async () => {
      setTauri(true)
      mockedSend.mockImplementation(() => {
        throw new Error("notif boom")
      })
      await expect(notify("x")).resolves.toBeUndefined()
      expect(warnSpy).toHaveBeenCalledWith("notify failed", expect.any(Error))
    })
  })
})
