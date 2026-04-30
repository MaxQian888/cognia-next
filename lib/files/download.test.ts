/**
 * @jest-environment jsdom
 */
import { downloadBlob, downloadFile, downloadFromUrl } from "./download"

describe("download helpers", () => {
  let createObjectURL: jest.Mock
  let revokeObjectURL: jest.Mock
  let originalCreate: typeof URL.createObjectURL
  let originalRevoke: typeof URL.revokeObjectURL
  let click: jest.Mock
  let appendChild: jest.SpyInstance
  let removeChild: jest.SpyInstance
  let createElement: jest.SpyInstance

  beforeEach(() => {
    originalCreate = URL.createObjectURL
    originalRevoke = URL.revokeObjectURL
    createObjectURL = jest.fn(() => "blob:test")
    revokeObjectURL = jest.fn()
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true })
    Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, configurable: true })

    click = jest.fn()
    const realCreate = document.createElement.bind(document)
    createElement = jest.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag === "a") {
        const a = realCreate("a") as HTMLAnchorElement
        a.click = click
        return a
      }
      return realCreate(tag)
    })
    appendChild = jest.spyOn(document.body, "appendChild")
    removeChild = jest.spyOn(document.body, "removeChild")
  })

  afterEach(() => {
    Object.defineProperty(URL, "createObjectURL", { value: originalCreate, configurable: true })
    Object.defineProperty(URL, "revokeObjectURL", { value: originalRevoke, configurable: true })
    createElement.mockRestore()
    appendChild.mockRestore()
    removeChild.mockRestore()
  })

  describe("downloadFile", () => {
    it("creates an anchor, clicks it, then revokes the object URL", () => {
      downloadFile("hello.txt", "hi")

      expect(createObjectURL).toHaveBeenCalledTimes(1)
      expect(click).toHaveBeenCalledTimes(1)
      expect(appendChild).toHaveBeenCalledTimes(1)
      expect(removeChild).toHaveBeenCalledTimes(1)
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:test")
    })

    it("uses the provided MIME type when set", () => {
      downloadFile("data.json", "{}", "application/json")
      const blobArg = (createObjectURL.mock.calls[0]?.[0] ?? null) as Blob | null
      expect(blobArg).not.toBeNull()
      expect(blobArg!.type).toBe("application/json")
    })
  })

  describe("downloadBlob", () => {
    it("creates an object URL, clicks the anchor, and revokes after", () => {
      const blob = new Blob(["abc"], { type: "image/svg+xml" })
      downloadBlob(blob, "diagram.svg")

      expect(createObjectURL).toHaveBeenCalledWith(blob)
      expect(click).toHaveBeenCalledTimes(1)
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:test")
    })

    it("revokes the object URL even when the click throws", () => {
      click.mockImplementationOnce(() => {
        throw new Error("nope")
      })
      const blob = new Blob(["x"])
      expect(() => downloadBlob(blob, "f")).toThrow("nope")
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:test")
    })
  })

  describe("downloadFromUrl", () => {
    it("uses the URL directly as the anchor href when fetchAsBlob is unset", async () => {
      await downloadFromUrl("https://example.com/audio.mp3", "audio.mp3")
      expect(click).toHaveBeenCalledTimes(1)
      expect(createObjectURL).not.toHaveBeenCalled()
    })

    it("fetches and downloads as a blob when fetchAsBlob is true", async () => {
      const blob = new Blob(["data"], { type: "image/png" })
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        blob: jest.fn().mockResolvedValue(blob),
      }) as unknown as typeof fetch

      await downloadFromUrl("https://example.com/img.png", "img.png", { fetchAsBlob: true })

      expect(global.fetch).toHaveBeenCalledWith("https://example.com/img.png")
      expect(createObjectURL).toHaveBeenCalledWith(blob)
      expect(click).toHaveBeenCalledTimes(1)
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:test")
    })

    it("throws a descriptive error when the fetch fails", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
        blob: jest.fn(),
      }) as unknown as typeof fetch

      await expect(
        downloadFromUrl("https://example.com/missing", "x", { fetchAsBlob: true })
      ).rejects.toThrow(/404 Not Found/)
    })
  })
})
