import { isMigrationVendor } from "./types"

describe("migration types", () => {
  it("recognizes the three supported vendors", () => {
    expect(["claude-code", "codex", "opencode"].every(isMigrationVendor)).toBe(true)
    expect(isMigrationVendor("cursor")).toBe(false)
  })
})
