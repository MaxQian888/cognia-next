/** @jest-environment jsdom */
import { uploadFile, downloadFile } from "./upload"

jest.mock("@tauri-apps/plugin-upload", () => ({
  upload: jest.fn(),
  download: jest.fn(),
}))

import { upload as uploadNative, download as downloadNative } from "@tauri-apps/plugin-upload"

const mockedUpload = uploadNative as jest.MockedFunction<typeof uploadNative>
const mockedDownload = downloadNative as jest.MockedFunction<typeof downloadNative>

const TAURI_KEY = "__TAURI_INTERNALS__"

function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>)[TAURI_KEY] = {}
  else delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
}

describe("lib/tauri/upload", () => {
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

  describe("uploadFile", () => {
    it("returns null outside Tauri without calling the native plugin", async () => {
      const result = await uploadFile("https://example.com/u", "/tmp/x")
      expect(result).toBeNull()
      expect(mockedUpload).not.toHaveBeenCalled()
    })

    it("returns the native response body inside Tauri", async () => {
      setTauri(true)
      mockedUpload.mockResolvedValue('{"ok":true}')
      await expect(uploadFile("https://example.com/u", "/tmp/x")).resolves.toBe('{"ok":true}')
      expect(mockedUpload).toHaveBeenCalledTimes(1)
    })

    it("forwards the onProgress callback verbatim", async () => {
      setTauri(true)
      mockedUpload.mockResolvedValue("")
      const onProgress = jest.fn()
      await uploadFile("https://example.com/u", "/tmp/x", { onProgress })
      expect(mockedUpload).toHaveBeenCalledWith(
        "https://example.com/u",
        "/tmp/x",
        onProgress,
        undefined
      )
    })

    it("converts a plain-object headers map into a Map", async () => {
      setTauri(true)
      mockedUpload.mockResolvedValue("")
      await uploadFile("https://example.com/u", "/tmp/x", {
        headers: { Authorization: "Bearer t" },
      })
      const headersArg = mockedUpload.mock.calls[0][3]
      expect(headersArg).toBeInstanceOf(Map)
      expect((headersArg as Map<string, string>).get("Authorization")).toBe("Bearer t")
    })

    it("passes a Map headers value through unchanged", async () => {
      setTauri(true)
      mockedUpload.mockResolvedValue("")
      const headers = new Map([["X-Custom", "v"]])
      await uploadFile("https://example.com/u", "/tmp/x", { headers })
      expect(mockedUpload.mock.calls[0][3]).toBe(headers)
    })

    it("logs and returns null when the native plugin rejects", async () => {
      setTauri(true)
      mockedUpload.mockRejectedValue(new Error("boom"))
      await expect(uploadFile("https://example.com/u", "/tmp/x")).resolves.toBeNull()
      expect(warnSpy).toHaveBeenCalledWith("uploadFile failed", expect.any(Error))
    })
  })

  describe("downloadFile", () => {
    it("returns false outside Tauri without calling the native plugin", async () => {
      const result = await downloadFile("https://example.com/u", "/tmp/x")
      expect(result).toBe(false)
      expect(mockedDownload).not.toHaveBeenCalled()
    })

    it("returns true on successful native download", async () => {
      setTauri(true)
      mockedDownload.mockResolvedValue(undefined)
      await expect(downloadFile("https://example.com/u", "/tmp/x")).resolves.toBe(true)
      expect(mockedDownload).toHaveBeenCalledTimes(1)
    })

    it("forwards the onProgress callback verbatim", async () => {
      setTauri(true)
      mockedDownload.mockResolvedValue(undefined)
      const onProgress = jest.fn()
      await downloadFile("https://example.com/u", "/tmp/x", { onProgress })
      expect(mockedDownload).toHaveBeenCalledWith(
        "https://example.com/u",
        "/tmp/x",
        onProgress,
        undefined
      )
    })

    it("logs and returns false when the native plugin rejects", async () => {
      setTauri(true)
      mockedDownload.mockRejectedValue(new Error("nope"))
      await expect(downloadFile("https://example.com/u", "/tmp/x")).resolves.toBe(false)
      expect(warnSpy).toHaveBeenCalledWith("downloadFile failed", expect.any(Error))
    })
  })
})
