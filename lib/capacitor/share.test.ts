/**
 * @jest-environment jsdom
 */
import { share } from "./share"

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
