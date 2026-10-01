import { PackageFormatError, packageFormatErrorCode, safeArchivePath } from "./archive-path"

describe("safeArchivePath", () => {
  it("normalizes separators, a leading ./ and empty segments", () => {
    expect(safeArchivePath("./plugins\\a//b/./c.json", 8, "Cogpack")).toBe("plugins/a/b/c.json")
  })

  it.each([
    ["", "is unsafe"],
    ["/etc/passwd", "is unsafe"],
    ["C:/Windows/x", "is unsafe"],
    ["a\0b", "is unsafe"],
    ["a/../../b", "escapes its root"],
  ])("refuses %j", (input, reason) => {
    expect(() => safeArchivePath(input, 8, "Cogpack")).toThrow(`Cogpack path ${reason}`)
  })

  it("refuses non-NFC names so one file cannot be named two ways", () => {
    expect(() => safeArchivePath("cafe\u0301.txt", 8, "Cogpack")).toThrow(
      "Cogpack path is not canonical Unicode"
    )
  })

  it("enforces the depth limit", () => {
    expect(safeArchivePath("a/b/c", 3, "X")).toBe("a/b/c")
    expect(() => safeArchivePath("a/b/c/d", 3, "X")).toThrow("X path depth is unsafe")
  })

  it("refuses with a typed error a UI can translate", () => {
    let caught: unknown
    try {
      safeArchivePath("../x", 8, "X")
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(PackageFormatError)
    expect(packageFormatErrorCode(caught)).toBe("unsafe-path")
    expect(packageFormatErrorCode(new Error("plain"))).toBeUndefined()
  })
})
