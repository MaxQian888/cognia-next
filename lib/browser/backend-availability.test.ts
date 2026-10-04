import {
  bestLocalDesktopBackend,
  resolveBrowserBackend,
  resolveDesktopBackend,
  type BrowserBackendInputs,
} from "./backend-availability"

const inputs = (over: Partial<BrowserBackendInputs> = {}): BrowserBackendInputs => ({
  tauri: true,
  remoteBrowserEnabled: false,
  remoteHostActive: false,
  webCompanionTarget: false,
  localChromiumInstalled: false,
  userChromeAvailable: false,
  ...over,
})

describe("resolveBrowserBackend", () => {
  it("keeps the embedded webview when the cloud browser is off", () => {
    expect(resolveBrowserBackend(inputs())).toEqual({
      backend: "embedded",
      remoteReachable: false,
      localReachable: false,
      userChromeReachable: false,
      reason: "remote-disabled",
    })
  })

  it("falls back to the sandboxed iframe off the desktop when it is off", () => {
    expect(resolveBrowserBackend(inputs({ tauri: false }))).toMatchObject({
      backend: "web-fallback",
      reason: "remote-disabled",
    })
  })

  it("reaches the cloud browser through an attached remote host", () => {
    expect(
      resolveBrowserBackend(inputs({ remoteBrowserEnabled: true, remoteHostActive: true }))
    ).toMatchObject({ backend: "remote", remoteReachable: true, reason: "remote-ready" })
  })

  it("reaches it through this shell's own pairing", () => {
    expect(
      resolveBrowserBackend(
        inputs({ tauri: false, remoteBrowserEnabled: true, webCompanionTarget: true })
      )
    ).toMatchObject({ backend: "remote", remoteReachable: true })
  })

  it("says so when it is switched on with nothing to talk to", () => {
    expect(resolveBrowserBackend(inputs({ remoteBrowserEnabled: true }))).toMatchObject({
      backend: "embedded",
      remoteReachable: false,
      reason: "no-remote-host",
    })
    expect(
      resolveBrowserBackend(inputs({ tauri: false, remoteBrowserEnabled: true }))
    ).toMatchObject({ backend: "web-fallback", reason: "no-remote-host" })
  })

  it("never reports local backends as reachable off the desktop", () => {
    expect(
      resolveBrowserBackend(
        inputs({ tauri: false, localChromiumInstalled: true, userChromeAvailable: true })
      )
    ).toMatchObject({ localReachable: false, userChromeReachable: false })
  })
})

describe("resolveDesktopBackend", () => {
  const reachable = inputs({ remoteBrowserEnabled: true, remoteHostActive: true })

  it("keeps the embedded webview as the default while nothing is installed", () => {
    expect(resolveDesktopBackend(reachable, null)).toMatchObject({
      backend: "embedded",
      remoteReachable: true,
      reason: "embedded-host",
    })
    expect(resolveDesktopBackend(inputs(), null)).toMatchObject({
      backend: "embedded",
      reason: "remote-disabled",
    })
  })

  it("makes local Chromium the default for every page once installed", () => {
    const installed = inputs({ localChromiumInstalled: true })
    expect(resolveDesktopBackend(installed, null)).toMatchObject({
      backend: "local-chromium",
      reason: "local-ready",
    })
    expect(resolveDesktopBackend({ ...installed, targetTier: "public" }, null)).toMatchObject({
      backend: "local-chromium",
    })
  })

  it("sends loopback pages to local Chromium too once installed (ADR-0214, D8)", () => {
    expect(
      resolveDesktopBackend(inputs({ localChromiumInstalled: true, targetTier: "trusted" }), null)
    ).toMatchObject({ backend: "local-chromium", reason: "local-ready" })
  })

  it("keeps an empty pane on the embedded webview rather than starting Chromium", () => {
    expect(
      resolveDesktopBackend(inputs({ localChromiumInstalled: true, idle: true }), null)
    ).toMatchObject({ backend: "embedded", reason: "remote-disabled" })
    // An explicit choice is still served.
    expect(
      resolveDesktopBackend(inputs({ localChromiumInstalled: true, idle: true }), "local-chromium")
    ).toMatchObject({ backend: "local-chromium" })
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
    expect(
      resolveDesktopBackend(inputs({ localChromiumInstalled: true }), "embedded")
    ).toMatchObject({ backend: "embedded", reason: "embedded-host" })
  })

  it("serves an explicit local Chromium choice only once installed", () => {
    expect(
      resolveDesktopBackend(inputs({ localChromiumInstalled: true }), "local-chromium")
    ).toMatchObject({ backend: "local-chromium", reason: "local-ready" })
    expect(resolveDesktopBackend(inputs(), "local-chromium")).toMatchObject({
      backend: "embedded",
      reason: "local-not-installed",
    })
  })

  it("attaches the user's Chrome only when chosen and available", () => {
    const available = inputs({ userChromeAvailable: true, localChromiumInstalled: true })
    expect(resolveDesktopBackend(available, null).backend).toBe("local-chromium")
    expect(resolveDesktopBackend(available, "user-chrome")).toMatchObject({
      backend: "user-chrome",
      reason: "user-chrome-ready",
    })
    expect(
      resolveDesktopBackend(inputs({ localChromiumInstalled: true }), "user-chrome")
    ).toMatchObject({ backend: "local-chromium", reason: "user-chrome-unavailable" })
    expect(resolveDesktopBackend(inputs(), "user-chrome")).toMatchObject({
      backend: "embedded",
      reason: "user-chrome-unavailable",
    })
  })

  it("leaves non-desktop shells to the plain resolver", () => {
    const web = inputs({ tauri: false, remoteBrowserEnabled: true, webCompanionTarget: true })
    expect(resolveDesktopBackend(web, "embedded")).toMatchObject({ backend: "remote" })
    expect(resolveDesktopBackend(web, "local-chromium")).toMatchObject({ backend: "remote" })
  })
})

describe("bestLocalDesktopBackend", () => {
  it("prefers the installed local Chromium, else the embedded webview", () => {
    expect(bestLocalDesktopBackend({ tauri: true, localChromiumInstalled: true })).toBe(
      "local-chromium"
    )
    expect(bestLocalDesktopBackend({ tauri: true, localChromiumInstalled: false })).toBe("embedded")
    expect(bestLocalDesktopBackend({ tauri: false, localChromiumInstalled: true })).toBe("embedded")
  })
})
