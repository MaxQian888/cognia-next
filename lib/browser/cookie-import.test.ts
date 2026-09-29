jest.mock("@/lib/tauri", () => ({ transport: { call: jest.fn() } }))

import { transport } from "@/lib/tauri"
import {
  clearAllSiteCookies,
  clearSiteCookies,
  cookieImportV2Message,
  importCookiesV2,
  listCookieDomains,
  listCookieSources,
  openFullDiskAccessSettings,
  type CookieImportV2Result,
} from "./cookie-import"

const call = transport.call as jest.Mock

beforeEach(() => call.mockReset())

// Removing an import must not depend on the setting that allowed it: turning
// the feature off is exactly when someone wants the imported sign-in gone.
it("clears the current site's cookies with the host alone, whatever the setting", async () => {
  call.mockResolvedValueOnce({ removed: 3, domain: "github.com" })
  await expect(clearSiteCookies("www.github.com")).resolves.toEqual({
    removed: 3,
    domain: "github.com",
  })
  expect(call).toHaveBeenCalledWith("browser_cookie_clear", { domain: "www.github.com" })
})

it("signs the preview out of every site through one native call", async () => {
  call.mockResolvedValueOnce({ removed: 7 })
  await expect(clearAllSiteCookies()).resolves.toEqual({ removed: 7 })
  expect(call).toHaveBeenCalledWith("browser_cookie_clear_all", {})
})

describe("cookie import", () => {
  it("lists sources and domains through metadata-only commands", async () => {
    const sources = [
      {
        browser: "firefox",
        label: "Firefox",
        kind: "firefox",
        profiles: [{ id: "Profiles/a.default", name: "default" }],
        supported: true,
        reason: null,
      },
    ]
    call.mockResolvedValueOnce(sources)
    await expect(listCookieSources()).resolves.toEqual(sources)
    expect(call).toHaveBeenCalledWith("browser_cookie_sources", {})

    call.mockResolvedValueOnce([{ domain: "github.com", count: 4 }])
    await expect(listCookieDomains("chrome", "Default")).resolves.toEqual([
      { domain: "github.com", count: 4 },
    ])
    expect(call).toHaveBeenCalledWith("browser_cookie_domains", {
      browser: "chrome",
      profile: "Default",
    })
  })

  it("forwards scope and sink coordinates, never values", async () => {
    call.mockResolvedValueOnce({ kind: "ok", injected: 2, skippedAppBound: 1, domains: ["a.com"] })
    await importCookiesV2({
      browser: "edge",
      profile: "Profile 1",
      scope: { kind: "domains", domains: ["a.com", "b.com"] },
      sink: "local",
      sessionId: "s1",
    })
    expect(call).toHaveBeenCalledWith("browser_cookie_import_v2", {
      browser: "edge",
      profile: "Profile 1",
      scope: { kind: "domains", domains: ["a.com", "b.com"] },
      sink: "local",
      sessionId: "s1",
    })
  })

  it("sends a null session for the embedded sink", async () => {
    call.mockResolvedValueOnce({ kind: "no_matching_cookies" })
    await importCookiesV2({
      browser: "safari",
      profile: "default",
      scope: { kind: "all" },
      sink: "embedded",
    })
    expect(call).toHaveBeenCalledWith("browser_cookie_import_v2", {
      browser: "safari",
      profile: "default",
      scope: { kind: "all" },
      sink: "embedded",
      sessionId: null,
    })
  })

  it("opens the Full Disk Access pane through a fixed command", async () => {
    call.mockResolvedValueOnce(undefined)
    await openFullDiskAccessSettings()
    expect(call).toHaveBeenCalledWith("browser_open_full_disk_access_settings", {})
  })

  it.each<[CookieImportV2Result, string]>([
    [{ kind: "permission_denied" }, "result.permissionDenied"],
    [{ kind: "full_disk_access_required" }, "result.fullDiskAccessRequired"],
    [{ kind: "no_profile" }, "result.noProfile"],
    [{ kind: "no_matching_cookies" }, "result.noMatchingCookies"],
    [{ kind: "unsupported", reason: "browser_running" }, "result.unsupported"],
  ])("maps %j to %s", (result, key) => {
    expect(cookieImportV2Message(result)).toEqual({ key })
  })

  it("reports injected and App-Bound skipped counts", () => {
    expect(
      cookieImportV2Message({ kind: "ok", injected: 5, skippedAppBound: 2, domains: [] })
    ).toEqual({ key: "result.ok", values: { count: 5, skipped: 2 } })
  })
})
