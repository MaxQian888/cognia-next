jest.mock("@/lib/browser/local-content-client", () => ({
  ...jest.requireActual("@/lib/browser/local-content-client"),
  serveLocalFile: jest.fn(),
}))

import { serveLocalFile } from "@/lib/browser/local-content-client"

import { pathToFileUrl, resolveBrowserAddress } from "./browser-address"

const serveMock = serveLocalFile as jest.Mock

beforeEach(() => serveMock.mockReset())

describe("pathToFileUrl", () => {
  it("encodes POSIX segments", () => {
    expect(pathToFileUrl("/Users/me/My Site/index.html")).toBe(
      "file:///Users/me/My%20Site/index.html"
    )
  })

  it("roots a Windows drive path", () => {
    expect(pathToFileUrl("C:\\work\\a b\\index.html")).toBe("file:///C:/work/a%20b/index.html")
  })
})

describe("resolveBrowserAddress", () => {
  it("normalizes a web address", async () => {
    await expect(resolveBrowserAddress("example.com", "embedded")).resolves.toEqual({
      kind: "url",
      url: "https://example.com/",
      local: false,
    })
  })

  it("reports garbage as invalid", async () => {
    await expect(resolveBrowserAddress("http://", "chromium")).resolves.toEqual({
      kind: "invalid",
    })
  })

  it("serves a local path through Rust for the embedded webview", async () => {
    serveMock.mockResolvedValue({ url: "http://127.0.0.1:5000/abc/index.html", root: "r" })
    await expect(resolveBrowserAddress("/tmp/site/index.html", "embedded")).resolves.toEqual({
      kind: "url",
      url: "http://127.0.0.1:5000/abc/index.html",
      local: true,
    })
    expect(serveMock).toHaveBeenCalledWith("/tmp/site/index.html")
  })

  it("opens file:// directly in Chromium", async () => {
    await expect(resolveBrowserAddress("/tmp/site/index.html", "chromium")).resolves.toEqual({
      kind: "url",
      url: "file:///tmp/site/index.html",
      local: true,
    })
    await expect(resolveBrowserAddress("file:///tmp/x.pdf", "chromium")).resolves.toEqual({
      kind: "url",
      url: "file:///tmp/x.pdf",
      local: true,
    })
    expect(serveMock).not.toHaveBeenCalled()
  })

  it("still serves a home-relative path in Chromium, which cannot expand ~", async () => {
    serveMock.mockResolvedValue({ url: "http://127.0.0.1:1/p/", root: "r" })
    await resolveBrowserAddress("~/site", "chromium")
    expect(serveMock).toHaveBeenCalledWith("~/site")
  })

  it("surfaces a serve failure", async () => {
    serveMock.mockRejectedValue(new Error("not_found"))
    await expect(resolveBrowserAddress("/missing", "embedded")).resolves.toEqual({
      kind: "error",
      message: "not_found",
    })
    serveMock.mockRejectedValue("denied")
    await expect(resolveBrowserAddress("/missing", "embedded")).resolves.toEqual({
      kind: "error",
      message: "denied",
    })
  })
})
