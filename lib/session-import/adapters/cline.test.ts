import { clineSessionSource } from "./cline"

describe("clineSessionSource", () => {
  it("covers current SDK sessions and legacy extension task artifacts", () => {
    expect(clineSessionSource.scanRoots("/home/u")).toEqual(
      expect.arrayContaining([
        "/home/u/.cline/sessions",
        expect.stringContaining("saoudrizwan.claude-dev"),
      ])
    )
    expect(clineSessionSource.verifiedAt).toBe("2026-08-29")
  })
})
