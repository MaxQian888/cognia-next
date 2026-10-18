import { parseRemoteDesktopViewerParams, remoteDesktopViewerHref } from "./viewer-href"

describe("remote desktop viewer href", () => {
  it("round-trips ids and mode for this desktop's own Host", () => {
    const href = remoteDesktopViewerHref({
      host: { kind: "local" },
      targetId: "t 1",
      bindingId: "b&2",
      mode: "view",
    })
    expect(href).toBe("/devices/remote-desktop?target=t+1&binding=b%262&mode=view")
    const params = new URLSearchParams(href.split("?")[1])
    expect(parseRemoteDesktopViewerParams(params)).toEqual({
      host: { kind: "local" },
      targetId: "t 1",
      bindingId: "b&2",
      mode: "view",
    })
  })

  it("names a remote Host by its ref", () => {
    const href = remoteDesktopViewerHref({
      host: { kind: "remote", hostRef: "companion:h1" },
      targetId: "t",
      bindingId: "b",
      mode: "control",
    })
    expect(href).toBe("/devices/remote-desktop?target=t&binding=b&mode=control&host=companion%3Ah1")
    expect(parseRemoteDesktopViewerParams(new URLSearchParams(href.split("?")[1]))?.host).toEqual({
      kind: "remote",
      hostRef: "companion:h1",
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
