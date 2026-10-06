import { matchFileLinks as matchPackageFileLinks } from "@cognia/error-parsers/file-links"
import { isAbsolutePath, matchFileLinks, resolveLinkPath } from "./terminal-links"

it("uses the shared file parser before resolving a terminal location", () => {
  expect(matchFileLinks).toBe(matchPackageFileLinks)
  const [link] = matchFileLinks("src/foo.ts:12:3 - error TS2304")
  expect(resolveLinkPath("/project", link.path)).toBe("/project/src/foo.ts")
  expect(link).toMatchObject({ line: 12, column: 3 })
})

describe("isAbsolutePath", () => {
  it("detects POSIX and Windows absolute paths", () => {
    expect(isAbsolutePath("/usr/x.ts")).toBe(true)
    expect(isAbsolutePath("C:\\a\\b.ts")).toBe(true)
    expect(isAbsolutePath("D:/a/b.ts")).toBe(true)
    expect(isAbsolutePath("src/a.ts")).toBe(false)
    expect(isAbsolutePath("./a.ts")).toBe(false)
  })
})

describe("resolveLinkPath", () => {
  it("passes absolute paths through", () => {
    expect(resolveLinkPath("/home/me", "/etc/x.conf")).toBe("/etc/x.conf")
  })

  it("joins relative paths against a POSIX cwd, stripping ./", () => {
    expect(resolveLinkPath("/home/me/proj", "src/a.ts")).toBe("/home/me/proj/src/a.ts")
    expect(resolveLinkPath("/home/me/proj/", "./src/a.ts")).toBe("/home/me/proj/src/a.ts")
  })

  it("joins against a Windows cwd with backslashes", () => {
    expect(resolveLinkPath("C:\\proj", "src\\a.ts")).toBe("C:\\proj\\src\\a.ts")
  })

  it("returns the path unchanged when cwd is unknown", () => {
    expect(resolveLinkPath(null, "src/a.ts")).toBe("src/a.ts")
    expect(resolveLinkPath(undefined, "src/a.ts")).toBe("src/a.ts")
  })
})
