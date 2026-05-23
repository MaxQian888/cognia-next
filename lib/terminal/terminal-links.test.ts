import { isAbsolutePath, matchFileLinks, resolveLinkPath } from "./terminal-links"

describe("matchFileLinks", () => {
  it("matches path:line:col", () => {
    const [m] = matchFileLinks("src/foo.ts:12:3 - error TS2304")
    expect(m).toMatchObject({ path: "src/foo.ts", line: 12, column: 3 })
    expect(m.start).toBe(0)
    expect(m.length).toBe("src/foo.ts:12:3".length)
  })

  it("matches path:line without a column", () => {
    const [m] = matchFileLinks("compiled ./lib/bar.rs:5 ok")
    expect(m).toMatchObject({ path: "./lib/bar.rs", line: 5, column: null })
  })

  it("matches a Windows drive path with location", () => {
    const [m] = matchFileLinks("C:\\proj\\a.py:7:1")
    expect(m).toMatchObject({ path: "C:\\proj\\a.py", line: 7, column: 1 })
  })

  it("matches tsc paren form path(line,col)", () => {
    const [m] = matchFileLinks("src/index.ts(12,3): error")
    expect(m).toMatchObject({ path: "src/index.ts", line: 12, column: 3 })
  })

  it("extracts the path inside a V8 stack frame", () => {
    const [m] = matchFileLinks("    at handler (/app/server.js:42:9)")
    expect(m).toMatchObject({ path: "/app/server.js", line: 42, column: 9 })
  })

  it("matches a path with no location", () => {
    const [m] = matchFileLinks("see docs/readme.md for details")
    expect(m).toMatchObject({ path: "docs/readme.md", line: null, column: null })
  })

  it("returns multiple matches in order", () => {
    const ms = matchFileLinks("a/x.ts:1 and b/y.ts:2")
    expect(ms.map((m) => m.path)).toEqual(["a/x.ts", "b/y.ts"])
  })

  it("ignores ordinary words without a separator", () => {
    expect(matchFileLinks("version 1.2.3 ready")).toEqual([])
    expect(matchFileLinks("")).toEqual([])
  })
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
