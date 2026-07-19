import { BrowserSessionError } from "./session-types"

describe("BrowserSessionError", () => {
  it("preserves the stable wire error code", () => {
    const error = new BrowserSessionError("browser_page_not_found", "Page not found")

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe("BrowserSessionError")
    expect(error.code).toBe("browser_page_not_found")
    expect(error.message).toBe("Page not found")
  })
})
