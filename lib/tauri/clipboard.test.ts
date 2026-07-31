/** @jest-environment jsdom */
import {
  readClipboardText,
  writeClipboardText,
  readClipboardImage,
  writeClipboardImage,
  clearClipboard,
} from "./clipboard"

jest.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readImage: jest.fn(),
  readText: jest.fn(),
  writeImage: jest.fn(),
  writeText: jest.fn(),
  clear: jest.fn(),
}))

const capReadText = jest.fn()
const capWriteText = jest.fn()
jest.mock("@/lib/capacitor/clipboard", () => ({
  readText: () => capReadText(),
  writeText: (value: string) => capWriteText(value),
}))

import {
  readImage as readImageNative,
  readText as readTextNative,
  writeImage as writeImageNative,
  writeText as writeTextNative,
  clear as clearNative,
} from "@tauri-apps/plugin-clipboard-manager"

const mockedReadImage = readImageNative as jest.MockedFunction<typeof readImageNative>
const mockedReadText = readTextNative as jest.MockedFunction<typeof readTextNative>
const mockedWriteImage = writeImageNative as jest.MockedFunction<typeof writeImageNative>
const mockedWriteText = writeTextNative as jest.MockedFunction<typeof writeTextNative>
const mockedClear = clearNative as jest.MockedFunction<typeof clearNative>

const TAURI_KEY = "__TAURI_INTERNALS__"

function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>)[TAURI_KEY] = {}
  else delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
}

describe("lib/tauri/clipboard", () => {
  let warnSpy: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    setTauri(false)
    // Default: not on mobile — the Capacitor wrapper self-gates to `unsupported`
    // so the browser `navigator.clipboard` paths run as before.
    capReadText.mockResolvedValue({ kind: "unsupported" })
    capWriteText.mockResolvedValue({ kind: "unsupported" })
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    setTauri(false)
    warnSpy.mockRestore()
    // Best-effort cleanup of navigator.clipboard
    try {
      delete (navigator as unknown as Record<string, unknown>).clipboard
    } catch {
      /* ignore */
    }
  })

  describe("readClipboardText", () => {
    it("uses native readText in Tauri and returns its value", async () => {
      setTauri(true)
      mockedReadText.mockResolvedValue("hello tauri")
      await expect(readClipboardText()).resolves.toBe("hello tauri")
    })

    it("logs and returns null when native readText fails", async () => {
      setTauri(true)
      mockedReadText.mockRejectedValue(new Error("fail"))
      await expect(readClipboardText()).resolves.toBeNull()
      expect(warnSpy).toHaveBeenCalledWith("readClipboardText failed", expect.any(Error))
    })

    it("falls back to navigator.clipboard.readText in browser", async () => {
      const readTextMock = jest.fn().mockResolvedValue("hello browser")
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { readText: readTextMock },
      })
      await expect(readClipboardText()).resolves.toBe("hello browser")
      expect(readTextMock).toHaveBeenCalledTimes(1)
    })

    it("returns null if navigator.clipboard.readText throws", async () => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { readText: jest.fn().mockRejectedValue(new Error("denied")) },
      })
      await expect(readClipboardText()).resolves.toBeNull()
    })

    it("returns null when neither backend is available", async () => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: undefined,
      })
      await expect(readClipboardText()).resolves.toBeNull()
    })

    it("uses the native Capacitor clipboard on mobile", async () => {
      capReadText.mockResolvedValueOnce({ kind: "ok", value: "from native" })
      const navReadText = jest.fn()
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { readText: navReadText },
      })
      await expect(readClipboardText()).resolves.toBe("from native")
      expect(navReadText).not.toHaveBeenCalled()
    })
  })

  describe("writeClipboardText", () => {
    it("uses native writeText in Tauri", async () => {
      setTauri(true)
      mockedWriteText.mockResolvedValue(undefined)
      await writeClipboardText("hi")
      expect(mockedWriteText).toHaveBeenCalledWith("hi")
    })

    it("falls back to navigator.clipboard.writeText in browser", async () => {
      const writeTextMock = jest.fn().mockResolvedValue(undefined)
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: writeTextMock },
      })
      await writeClipboardText("hi")
      expect(writeTextMock).toHaveBeenCalledWith("hi")
    })

    it("is a no-op when navigator.clipboard is unavailable", async () => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: undefined,
      })
      await expect(writeClipboardText("hi")).resolves.toBeUndefined()
    })

    it("uses the native Capacitor clipboard on mobile without touching navigator", async () => {
      capWriteText.mockResolvedValueOnce({ kind: "ok" })
      const navWriteText = jest.fn()
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: navWriteText },
      })
      await writeClipboardText("hi")
      expect(capWriteText).toHaveBeenCalledWith("hi")
      expect(navWriteText).not.toHaveBeenCalled()
    })
  })

  describe("readClipboardImage", () => {
    it("returns null outside Tauri", async () => {
      await expect(readClipboardImage()).resolves.toBeNull()
      expect(mockedReadImage).not.toHaveBeenCalled()
    })

    it("returns Uint8Array of rgba bytes when in Tauri", async () => {
      setTauri(true)
      const rgba = new ArrayBuffer(4)
      new Uint8Array(rgba).set([1, 2, 3, 4])
      const fakeImg = { rgba: jest.fn().mockResolvedValue(rgba) }
      mockedReadImage.mockResolvedValue(
        fakeImg as unknown as Awaited<ReturnType<typeof readImageNative>>
      )
      const result = await readClipboardImage()
      expect(result).toBeInstanceOf(Uint8Array)
      expect(Array.from(result as Uint8Array)).toEqual([1, 2, 3, 4])
    })

    it("logs and returns null when native readImage rejects", async () => {
      setTauri(true)
      mockedReadImage.mockRejectedValue(new Error("img boom"))
      await expect(readClipboardImage()).resolves.toBeNull()
      expect(warnSpy).toHaveBeenCalledWith("readClipboardImage failed", expect.any(Error))
    })
  })

  describe("writeClipboardImage", () => {
    it("is a no-op outside Tauri", async () => {
      await writeClipboardImage(new Uint8Array([1, 2, 3]))
      expect(mockedWriteImage).not.toHaveBeenCalled()
    })

    it("calls native writeImage in Tauri", async () => {
      setTauri(true)
      mockedWriteImage.mockResolvedValue(undefined)
      const bytes = new Uint8Array([1, 2, 3])
      await writeClipboardImage(bytes)
      expect(mockedWriteImage).toHaveBeenCalledWith(bytes)
    })
  })

  describe("clearClipboard", () => {
    it("is a no-op outside Tauri", async () => {
      await clearClipboard()
      expect(mockedClear).not.toHaveBeenCalled()
    })

    it("calls native clear in Tauri", async () => {
      setTauri(true)
      mockedClear.mockResolvedValue(undefined)
      await clearClipboard()
      expect(mockedClear).toHaveBeenCalledTimes(1)
    })
  })
})
