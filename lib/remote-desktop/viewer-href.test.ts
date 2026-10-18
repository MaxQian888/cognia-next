import { parseRemoteDesktopViewerParams, remoteDesktopViewerHref } from "./viewer-href"

describe("remote desktop viewer href", () => {
  it("round-trips ids and mode", () => {
    const href = remoteDesktopViewerHref({ targetId: "t 1", bindingId: "b&2", mode: "view" })
    expect(href).toBe("/devices/remote-desktop?target=t+1&binding=b%262&mode=view")
    const params = new URLSearchParams(href.split("?")[1])
    expect(parseRemoteDesktopViewerParams(params)).toEqual({
      targetId: "t 1",
      bindingId: "b&2",
      mode: "view",
    })
  })

  it("defaults to control and refuses a link without ids", () => {
    expect(parseRemoteDesktopViewerParams(new URLSearchParams("target=t&binding=b"))?.mode).toBe(
      "control"
    )
    expect(parseRemoteDesktopViewerParams(new URLSearchParams("target=t"))).toBeNull()
    expect(parseRemoteDesktopViewerParams(new URLSearchParams(""))).toBeNull()
  })
})
