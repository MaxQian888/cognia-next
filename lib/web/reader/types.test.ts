import { safeHostname } from "./types"

describe("safeHostname", () => {
  it("lower-cases the hostname of a valid URL", () => {
    expect(safeHostname("https://Example.COM/path")).toBe("example.com")
  })

  it("returns null for a malformed URL", () => {
    expect(safeHostname("not a url")).toBeNull()
    expect(safeHostname("")).toBeNull()
  })
})
