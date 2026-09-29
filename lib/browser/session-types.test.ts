import {
  BROWSER_DOWNLOAD_STATES,
  BrowserSessionError,
  isBrowserDownloadSettled,
  isBrowserDownloadSummary,
} from "./session-types"

describe("BrowserSessionError", () => {
  it("preserves the stable wire error code", () => {
    const error = new BrowserSessionError("browser_page_not_found", "Page not found")

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe("BrowserSessionError")
    expect(error.code).toBe("browser_page_not_found")
    expect(error.message).toBe("Page not found")
  })
})

describe("BrowserDownloadSummary", () => {
  const base = { id: "d1", sessionId: "s1", filename: "a.pdf", size: 10 }

  it("accepts every lifecycle state and rejects unknown ones", () => {
    for (const state of BROWSER_DOWNLOAD_STATES) {
      expect(isBrowserDownloadSummary({ ...base, state })).toBe(true)
    }
    expect(isBrowserDownloadSummary({ ...base, state: "pending" })).toBe(false)
    expect(isBrowserDownloadSummary({ ...base, size: "10", state: "completed" })).toBe(false)
    expect(isBrowserDownloadSummary(null)).toBe(false)
    expect(isBrowserDownloadSummary([])).toBe(false)
  })

  it("treats only in_progress as unsettled", () => {
    expect(isBrowserDownloadSettled("in_progress")).toBe(false)
    expect(isBrowserDownloadSettled("completed")).toBe(true)
    expect(isBrowserDownloadSettled("quarantined")).toBe(true)
  })
})
