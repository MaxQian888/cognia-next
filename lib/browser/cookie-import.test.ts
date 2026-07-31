jest.mock("@/lib/tauri", () => ({ transport: { call: jest.fn() } }))

import { transport } from "@/lib/tauri"
import {
  cookieImportMessage,
  importChromeCookies,
  isChromeCookieImportAvailable,
  type CookieImportResult,
} from "./cookie-import"

const call = transport.call as jest.Mock

beforeEach(() => call.mockReset())

it("short-circuits availability while the feature is disabled", async () => {
  await expect(isChromeCookieImportAvailable("chrome", false)).resolves.toEqual({
    supported: false,
    profiles: [],
    reason: "feature_disabled",
  })
  expect(call).not.toHaveBeenCalled()
})

it("probes the selected browser without triggering an import", async () => {
  call.mockResolvedValueOnce({ supported: true, profiles: ["Default"], reason: null })
  await expect(isChromeCookieImportAvailable("brave", true)).resolves.toEqual({
    supported: true,
    profiles: ["Default"],
    reason: null,
  })
  expect(call).toHaveBeenCalledWith("browser_cookie_import_available", { browser: "brave" })
})

it("keeps decrypted values inside Rust by forwarding only import coordinates", async () => {
  call.mockResolvedValueOnce({
    kind: "ok",
    injected: 2,
    names: ["session"],
    domains: [".github.com"],
  })
  await importChromeCookies({
    browser: "chrome",
    profile: "Default",
    domain: "github.com",
    featureEnabled: true,
  })
  expect(call).toHaveBeenCalledWith("browser_cookie_import", {
    browser: "chrome",
    profile: "Default",
    domain: "github.com",
  })
})

it("short-circuits import while the feature is disabled", async () => {
  await expect(
    importChromeCookies({
      browser: "chrome",
      profile: "Default",
      domain: "github.com",
      featureEnabled: false,
    })
  ).resolves.toEqual({ kind: "unsupported", reason: "feature_disabled" })
  expect(call).not.toHaveBeenCalled()
})

it.each<[CookieImportResult, string]>([
  [{ kind: "ok", injected: 3, names: [], domains: [] }, "result.ok"],
  [{ kind: "unsupported", reason: "macos_only" }, "result.unsupported"],
  [{ kind: "unsupported", reason: "feature_disabled" }, "result.featureDisabled"],
  [{ kind: "permission_denied" }, "result.permissionDenied"],
  [{ kind: "no_profile" }, "result.noProfile"],
  [{ kind: "no_matching_cookies" }, "result.noMatchingCookies"],
])("maps %j to the localized message key", (result, key) => {
  expect(cookieImportMessage(result).key).toBe(key)
})
