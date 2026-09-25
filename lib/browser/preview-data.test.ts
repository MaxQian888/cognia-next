/** @jest-environment jsdom */
let mockTauri = true
jest.mock("@/lib/tauri", () => ({ isTauri: () => mockTauri }))
jest.mock("@/lib/browser/cookie-import", () => ({ clearAllSiteCookies: jest.fn() }))

import { clearAllSiteCookies } from "@/lib/browser/cookie-import"
import {
  BROWSER_PREVIEW_STORAGE_KEYS,
  COOKIE_IMPORT_CONSENT_STORAGE_KEY,
  clearBrowserPreviewData,
} from "./preview-data"

const clearCookies = clearAllSiteCookies as jest.Mock

beforeEach(() => {
  mockTauri = true
  window.localStorage.clear()
  clearCookies.mockReset().mockResolvedValue({ removed: 4 })
})

it("forgets the browser's preferences and its consent to read Chromium cookies", async () => {
  for (const key of BROWSER_PREVIEW_STORAGE_KEYS) window.localStorage.setItem(key, "1")
  window.localStorage.setItem("cognia.unrelated", "keep")

  await clearBrowserPreviewData()

  for (const key of BROWSER_PREVIEW_STORAGE_KEYS) {
    expect(window.localStorage.getItem(key)).toBeNull()
  }
  expect(window.localStorage.getItem("cognia.unrelated")).toBe("keep")
  expect(BROWSER_PREVIEW_STORAGE_KEYS).toContain(COOKIE_IMPORT_CONSENT_STORAGE_KEY)
})

it("signs the desktop preview out of every site", async () => {
  await expect(clearBrowserPreviewData()).resolves.toEqual({ cookiesRemoved: 4 })
  expect(clearCookies).toHaveBeenCalledTimes(1)
})

it("has no cookie store to clear off the desktop", async () => {
  mockTauri = false
  await expect(clearBrowserPreviewData()).resolves.toEqual({ cookiesRemoved: 0 })
  expect(clearCookies).not.toHaveBeenCalled()
})

it("lets a failed cookie clear reach the caller", async () => {
  clearCookies.mockRejectedValue(new Error("no webview"))
  await expect(clearBrowserPreviewData()).rejects.toThrow("no webview")
})
