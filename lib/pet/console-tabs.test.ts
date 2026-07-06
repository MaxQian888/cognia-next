import { PET_CONSOLE_TABS, isPetConsoleTab } from "./console-tabs"

describe("console-tabs", () => {
  it("accepts every canonical tab id", () => {
    for (const tab of PET_CONSOLE_TABS) expect(isPetConsoleTab(tab)).toBe(true)
  })

  it("rejects unknown values and non-strings", () => {
    expect(isPetConsoleTab("settings")).toBe(false)
    expect(isPetConsoleTab("")).toBe(false)
    expect(isPetConsoleTab(42)).toBe(false)
    expect(isPetConsoleTab(null)).toBe(false)
    expect(isPetConsoleTab(undefined)).toBe(false)
  })
})
