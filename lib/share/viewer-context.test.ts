import { shareViewerRunsInApp } from "./viewer-context"

describe("shareViewerRunsInApp", () => {
  it("is true inside a native shell whatever the origin", () => {
    expect(
      shareViewerRunsInApp({
        origin: "https://share.cognia.cn",
        shareBaseUrl: "https://share.cognia.cn",
        nativeShell: true,
      })
    ).toBe(true)
  })

  it("is false on the web when the page is served from the share host", () => {
    expect(
      shareViewerRunsInApp({
        origin: "https://share.cognia.cn",
        shareBaseUrl: "https://share.cognia.cn",
        nativeShell: false,
      })
    ).toBe(false)
  })

  it("ignores the path when comparing the share endpoint", () => {
    expect(
      shareViewerRunsInApp({
        origin: "https://share.cognia.cn",
        shareBaseUrl: "https://share.cognia.cn/v1",
        nativeShell: false,
      })
    ).toBe(false)
  })

  it("is true for a dev or self-hosted app on another origin", () => {
    expect(
      shareViewerRunsInApp({
        origin: "http://localhost:3000",
        shareBaseUrl: "https://share.cognia.cn",
        nativeShell: false,
      })
    ).toBe(true)
  })

  it("fails closed when the page origin cannot be parsed", () => {
    expect(
      shareViewerRunsInApp({
        origin: "",
        shareBaseUrl: "https://share.example",
        nativeShell: false,
      })
    ).toBe(false)
  })

  it("treats an unconfigured share endpoint as not-the-public-host", () => {
    expect(
      shareViewerRunsInApp({
        origin: "http://localhost:3000",
        shareBaseUrl: "",
        nativeShell: false,
      })
    ).toBe(true)
  })
})
