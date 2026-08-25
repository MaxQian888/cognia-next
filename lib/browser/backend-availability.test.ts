import { resolveBrowserBackend, resolveDesktopBackend } from "./backend-availability"

const inputs = (over: Partial<Parameters<typeof resolveBrowserBackend>[0]> = {}) => ({
  tauri: true,
  remoteBrowserEnabled: false,
  remoteHostActive: false,
  webCompanionTarget: false,
  ...over,
})

describe("resolveBrowserBackend", () => {
  it("keeps the embedded webview when the cloud browser is off", () => {
    expect(resolveBrowserBackend(inputs())).toEqual({
      backend: "embedded",
      remoteReachable: false,
      reason: "remote-disabled",
    })
  })

  it("falls back to the sandboxed iframe off the desktop when it is off", () => {
    expect(resolveBrowserBackend(inputs({ tauri: false }))).toMatchObject({
      backend: "web-fallback",
      reason: "remote-disabled",
    })
  })

  // The whole point: shell was the wrong question. A desktop attached to a
  // remote Cognia host can reach the cloud browser; one that is not, cannot.
  it("reaches the cloud browser through an attached remote host", () => {
    expect(
      resolveBrowserBackend(inputs({ remoteBrowserEnabled: true, remoteHostActive: true }))
    ).toEqual({ backend: "remote", remoteReachable: true, reason: "remote-ready" })
  })

  it("reaches it through this shell's own pairing", () => {
    expect(
      resolveBrowserBackend(
        inputs({ tauri: false, remoteBrowserEnabled: true, webCompanionTarget: true })
      )
    ).toMatchObject({ backend: "remote", remoteReachable: true })
  })

  it("says so when it is switched on with nothing to talk to", () => {
    expect(resolveBrowserBackend(inputs({ remoteBrowserEnabled: true }))).toEqual({
      backend: "embedded",
      remoteReachable: false,
      reason: "no-remote-host",
    })
    expect(
      resolveBrowserBackend(inputs({ tauri: false, remoteBrowserEnabled: true }))
    ).toMatchObject({ backend: "web-fallback", reason: "no-remote-host" })
  })
})

describe("resolveDesktopBackend", () => {
  const reachable = inputs({ remoteBrowserEnabled: true, remoteHostActive: true })

  it("keeps the embedded webview as the desktop default even when remote is reachable", () => {
    expect(resolveDesktopBackend(reachable, null)).toMatchObject({
      backend: "embedded",
      remoteReachable: true,
      reason: "embedded-host",
    })
  })

  it("honours an explicit switch to the cloud browser", () => {
    expect(resolveDesktopBackend(reachable, "remote")).toMatchObject({ backend: "remote" })
  })

  it("refuses to switch to a cloud browser that is not reachable", () => {
    expect(resolveDesktopBackend(inputs({ remoteBrowserEnabled: true }), "remote")).toMatchObject({
      backend: "embedded",
      remoteReachable: false,
    })
  })

  it("honours an explicit switch back to the embedded webview", () => {
    expect(resolveDesktopBackend(reachable, "embedded")).toMatchObject({ backend: "embedded" })
  })

  it("leaves non-desktop shells to the plain resolver", () => {
    const web = inputs({ tauri: false, remoteBrowserEnabled: true, webCompanionTarget: true })
    expect(resolveDesktopBackend(web, "embedded")).toMatchObject({ backend: "remote" })
  })
})
