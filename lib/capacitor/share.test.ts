/**
 * @jest-environment jsdom
 */
import { share, shareContent } from "./share"

describe("share", () => {
  it("returns shared with activityType on native success", async () => {
    const out = await share({
      text: "hi",
      loader: async () => ({
        canShare: async () => ({ value: true }),
        share: async () => ({ activityType: "com.apple.UIKit.activity.Mail" }),
      }),
    })
    expect(out).toEqual({
      kind: "shared",
      activityType: "com.apple.UIKit.activity.Mail",
    })
  })

  it("falls back to navigator.share when canShare returns false", async () => {
    const navShare = jest.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "share", { configurable: true, value: navShare })
    const out = await share({
      text: "hi",
      loader: async () => ({
        canShare: async () => ({ value: false }),
        share: jest.fn(),
      }),
    })
    expect(navShare).toHaveBeenCalled()
    expect(out).toEqual({ kind: "shared" })
  })

  it("falls back to navigator.share when plugin missing", async () => {
    const navShare = jest.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "share", { configurable: true, value: navShare })
    const out = await share({
      text: "hi",
      loader: async () => {
        throw new Error("not native")
      },
    })
    expect(navShare).toHaveBeenCalled()
    expect(out).toEqual({ kind: "shared" })
  })

  it("returns unsupported when neither plugin nor navigator.share present", async () => {
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined })
    const out = await share({
      text: "hi",
      loader: async () => {
        throw new Error("nope")
      },
    })
    expect(out).toEqual({ kind: "unsupported" })
  })

  it("returns cancelled when share throws cancel error", async () => {
    const out = await share({
      text: "hi",
      loader: async () => ({
        canShare: async () => ({ value: true }),
        share: async () => {
          throw new Error("Share canceled")
        },
      }),
    })
    expect(out).toEqual({ kind: "cancelled" })
  })

  it("returns error for non-cancel exception", async () => {
    const out = await share({
      text: "hi",
      loader: async () => ({
        canShare: async () => ({ value: true }),
        share: async () => {
          throw new Error("unexpected")
        },
      }),
    })
    expect(out).toEqual({ kind: "error", message: "unexpected" })
  })
})

describe("shareContent", () => {
  type Win = typeof window & { Capacitor?: { isNativePlatform?: () => boolean } }
  afterEach(() => {
    delete (window as Win).Capacitor
  })

  function nativeShareLoader(shareFn: jest.Mock) {
    return async () => ({ canShare: async () => ({ value: true }), share: shareFn })
  }

  it("writes files into the cache and shares their native URIs on mobile", async () => {
    ;(window as Win).Capacitor = { isNativePlatform: () => true }
    const shareFn = jest.fn(async () => ({}))
    const writeCacheFile = jest.fn(async (path: string) => ({
      kind: "ok" as const,
      value: { uri: `file:///cache/${path}` },
    }))
    const file = new File(["png-bytes"], "shot/1.png", { type: "image/png" })
    const out = await shareContent({
      text: "look",
      files: [file],
      loader: nativeShareLoader(shareFn),
      writeCacheFile,
    })
    expect(out).toEqual({ kind: "shared", activityType: undefined })
    expect(writeCacheFile).toHaveBeenCalledWith("share/1-shot_1.png", expect.any(String))
    expect(shareFn).toHaveBeenCalledWith(
      expect.objectContaining({ text: "look", files: ["file:///cache/share/1-shot_1.png"] })
    )
  })

  it("shares text through the native plugin on mobile without touching the cache", async () => {
    ;(window as Win).Capacitor = { isNativePlatform: () => true }
    const shareFn = jest.fn(async () => ({}))
    const writeCacheFile = jest.fn()
    const out = await shareContent({
      text: "hi",
      loader: nativeShareLoader(shareFn),
      writeCacheFile,
    })
    expect(out.kind).toBe("shared")
    expect(writeCacheFile).not.toHaveBeenCalled()
    expect((shareFn.mock.calls[0] as unknown[])[0]).toMatchObject({ text: "hi", files: undefined })
  })

  it("reports a failed cache write instead of sharing without the file", async () => {
    ;(window as Win).Capacitor = { isNativePlatform: () => true }
    const shareFn = jest.fn()
    const out = await shareContent({
      files: [new File(["x"], "a.txt")],
      loader: nativeShareLoader(shareFn),
      writeCacheFile: async () => ({ kind: "error", message: "disk full" }),
    })
    expect(out).toEqual({ kind: "error", message: "disk full" })
    expect(shareFn).not.toHaveBeenCalled()
  })

  it("uses the Web Share API with files when the browser accepts them", async () => {
    const navShare = jest.fn(async () => {})
    const nav = { share: navShare, canShare: () => true } as unknown as Navigator
    const file = new File(["x"], "a.png", { type: "image/png" })
    const out = await shareContent({ text: "t", files: [file], nav })
    expect(out).toEqual({ kind: "shared" })
    expect(navShare).toHaveBeenCalledWith({ text: "t", files: [file] })
  })

  it("reports unsupported when the browser cannot share the files", async () => {
    const nav = { share: jest.fn(), canShare: () => false } as unknown as Navigator
    const out = await shareContent({ files: [new File(["x"], "a.png")], nav })
    expect(out).toEqual({ kind: "unsupported" })
  })

  it("reports unsupported without a Web Share API and cancelled on AbortError", async () => {
    await expect(shareContent({ text: "t", nav: {} as Navigator })).resolves.toEqual({
      kind: "unsupported",
    })
    const abort = Object.assign(new Error("Share canceled"), { name: "AbortError" })
    const nav = { share: jest.fn(async () => Promise.reject(abort)) } as unknown as Navigator
    await expect(shareContent({ text: "t", nav })).resolves.toEqual({ kind: "cancelled" })
  })
})
