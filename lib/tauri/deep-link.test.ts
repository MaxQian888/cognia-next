import { onDeepLink, getLaunchDeepLink, type DeepLinkHandler } from "./deep-link"

jest.mock("@tauri-apps/plugin-deep-link", () => ({
  onOpenUrl: jest.fn(),
  getCurrent: jest.fn(),
}))

import { onOpenUrl, getCurrent } from "@tauri-apps/plugin-deep-link"

const mockedOnOpenUrl = onOpenUrl as jest.MockedFunction<typeof onOpenUrl>
const mockedGetCurrent = getCurrent as jest.MockedFunction<typeof getCurrent>

const TAURI_KEY = "__TAURI_INTERNALS__"

function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>)[TAURI_KEY] = {}
  else delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
}

describe("lib/tauri/deep-link", () => {
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

  describe("onDeepLink", () => {
    it("returns a no-op unsubscribe outside Tauri", async () => {
      const handler: DeepLinkHandler = jest.fn()
      const unsub = await onDeepLink(handler)
      expect(typeof unsub).toBe("function")
      expect(() => unsub()).not.toThrow()
      expect(mockedOnOpenUrl).not.toHaveBeenCalled()
    })

    it("subscribes via native onOpenUrl in Tauri and forwards URLs", async () => {
      setTauri(true)
      const handler = jest.fn()
      const unsub = jest.fn()
      mockedOnOpenUrl.mockImplementation(async (cb: (urls: string[]) => void) => {
        cb(["cognia://chat/1"])
        return unsub
      })
      const returned = await onDeepLink(handler)
      expect(handler).toHaveBeenCalledWith(["cognia://chat/1"])
      expect(returned).toBe(unsub)
    })
  })

  describe("getLaunchDeepLink", () => {
    it("returns null outside Tauri", async () => {
      await expect(getLaunchDeepLink()).resolves.toBeNull()
      expect(mockedGetCurrent).not.toHaveBeenCalled()
    })

    it("returns the current URL list when in Tauri", async () => {
      setTauri(true)
      mockedGetCurrent.mockResolvedValue(["cognia://x"])
      await expect(getLaunchDeepLink()).resolves.toEqual(["cognia://x"])
    })

    it("normalizes undefined return to null", async () => {
      setTauri(true)
      mockedGetCurrent.mockResolvedValue(undefined as unknown as string[])
      await expect(getLaunchDeepLink()).resolves.toBeNull()
    })

    it("normalizes null return to null", async () => {
      setTauri(true)
      mockedGetCurrent.mockResolvedValue(null as unknown as string[])
      await expect(getLaunchDeepLink()).resolves.toBeNull()
    })

    it("logs and returns null when native getCurrent rejects", async () => {
      setTauri(true)
      mockedGetCurrent.mockRejectedValue(new Error("dl boom"))
      await expect(getLaunchDeepLink()).resolves.toBeNull()
      expect(warnSpy).toHaveBeenCalledWith("getLaunchDeepLink failed", expect.any(Error))
    })
  })
})
