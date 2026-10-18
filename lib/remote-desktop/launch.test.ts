jest.mock("@/lib/tauri/transport-instance", () => ({ localTransport: { call: jest.fn() } }))

import {
  isOpenableConsoleUrl,
  isRustdeskLaunchUri,
  openConsoleOutside,
  openExternalApp,
  openLaunched,
} from "./launch"

const URI = "rustdesk://connection/new/123456789@rd.example.com:21116?key=Ab%2B%2F%3D"

describe("remote desktop launch", () => {
  it("accepts only the RustDesk link form the Host builds", () => {
    expect(isRustdeskLaunchUri(URI)).toBe(true)
    expect(isRustdeskLaunchUri("rustdesk://connection/new/Office_PC-2")).toBe(true)
    expect(isRustdeskLaunchUri("rustdesk://connection/new/123456789@[fd00::1]:21116")).toBe(true)
    for (const uri of [
      "rustdesk://123456789",
      "rustdesk://config/abc",
      "rustdesk://password/abc",
      "rustdesk://connection/new/123456789?password=x",
      "rustdesk://connection/new/123456789?key=a&password=x",
      "rustdesk://connection/new/123456789/extra",
      "rustdesk://connection/new/12345",
      "https://example.com",
      "javascript:alert(1)",
    ]) {
      expect(isRustdeskLaunchUri(uri)).toBe(false)
    }
  })

  it("accepts http(s) console links without a login in them", () => {
    expect(isOpenableConsoleUrl("https://gw.lan/#/client/abc")).toBe(true)
    expect(isOpenableConsoleUrl("http://192.168.1.4:8080/?gotonode=n&viewmode=11")).toBe(true)
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://user:pw@gw.lan/",
      "https://mesh.lan/?gotonode=n&LoginToken=x",
      "https://gw.lan/#/client/abc?token=x",
      "not a url",
      `https://gw.lan/${"a".repeat(2048)}`,
    ]) {
      expect(isOpenableConsoleUrl(url)).toBe(false)
    }
  })

  it("opens RustDesk through Rust on the desktop and maps a failure to a missing app", async () => {
    const openAppOnDesktop = jest.fn().mockResolvedValue(undefined)
    await openExternalApp(URI, { kind: "desktop", openAppOnDesktop })
    expect(openAppOnDesktop).toHaveBeenCalledWith(URI)
    await expect(
      openExternalApp(URI, {
        kind: "desktop",
        openAppOnDesktop: jest.fn().mockRejectedValue(new Error("no handler")),
      })
    ).rejects.toMatchObject({ code: "remote_desktop_launch_app_missing" })
    await expect(
      openExternalApp("rustdesk://config/x", { kind: "desktop", openAppOnDesktop })
    ).rejects.toMatchObject({ code: "remote_desktop_launch_uri_invalid" })
    expect(openAppOnDesktop).toHaveBeenCalledTimes(1)
  })

  it("hands RustDesk to the native handoff on a phone and says when it is missing", async () => {
    const handoff = jest.fn().mockResolvedValue(true)
    await openExternalApp(URI, {
      kind: "phone",
      handoffAvailable: async () => true,
      handoff,
    })
    expect(handoff).toHaveBeenCalledWith(URI)
    const neverAsked = jest.fn()
    await expect(
      openExternalApp(URI, {
        kind: "phone",
        handoffAvailable: async () => false,
        handoff: neverAsked,
      })
    ).rejects.toMatchObject({ code: "remote_desktop_launch_app_missing" })
    expect(neverAsked).not.toHaveBeenCalled()
  })

  it("navigates to RustDesk on the Web and opens consoles in a tab or the in-app browser", async () => {
    const navigate = jest.fn()
    await openExternalApp(URI, { kind: "web", navigate })
    expect(navigate).toHaveBeenCalledWith(URI)
    const openTab = jest.fn()
    await openLaunched(
      { kind: "web-console", url: "https://gw.lan/#/client/x", profile: "guacamole" },
      { kind: "web", openTab }
    )
    expect(openTab).toHaveBeenCalledWith("https://gw.lan/#/client/x")
    const openInAppBrowser = jest.fn().mockResolvedValue(false)
    await expect(
      openConsoleOutside("https://gw.lan/#/client/x", { kind: "phone", openInAppBrowser })
    ).rejects.toMatchObject({ code: "remote_desktop_console_unavailable" })
    await expect(
      openConsoleOutside("https://gw.lan/?password=x", { kind: "web", openTab })
    ).rejects.toMatchObject({ code: "remote_desktop_console_url_invalid" })
    expect(openTab).toHaveBeenCalledTimes(1)
  })
})
