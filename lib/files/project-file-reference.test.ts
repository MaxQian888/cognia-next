import { parseProjectFileReference } from "./project-file-reference"

describe("parseProjectFileReference", () => {
  it("parses an absolute path with a colon line and column", () => {
    expect(parseProjectFileReference("/repo/src/app.ts:12:4")).toEqual({
      absolutePath: "/repo/src/app.ts",
      line: 12,
      column: 4,
    })
  })

  it("resolves a relative path and GitHub-style fragment against the project root", () => {
    expect(parseProjectFileReference("src/app.ts#L7C2", "/repo")).toEqual({
      absolutePath: "/repo/src/app.ts",
      line: 7,
      column: 2,
    })
  })

  it("decodes file URLs", () => {
    expect(parseProjectFileReference("file:///repo/src/hello%20world.ts#L3")).toEqual({
      absolutePath: "/repo/src/hello world.ts",
      line: 3,
    })
  })

  it("supports Windows paths and separators", () => {
    expect(parseProjectFileReference("src\\app.ts:9", "C:\\repo")).toEqual({
      absolutePath: "C:/repo/src/app.ts",
      line: 9,
    })
  })

  it.each([
    ["https://example.com/src/app.ts", "/repo"],
    ["mailto:dev@example.com", "/repo"],
    ["#section", "/repo"],
    ["../outside.ts", "/repo"],
    ["src/app.ts", undefined],
    ["/settings", "/repo"],
    ["src/app.ts:0", "/repo"],
    ["src/app.ts:2:0", "/repo"],
    ["src/app.ts#L0C2", "/repo"],
  ])("rejects non-project reference %s", (reference, root) => {
    expect(parseProjectFileReference(reference, root)).toBeNull()
  })
})
