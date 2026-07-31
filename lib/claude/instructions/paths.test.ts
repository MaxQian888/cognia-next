import {
  detectSep,
  stripTrailingSep,
  joinPath,
  dirname,
  basename,
  isRoot,
  pathKey,
  isDescendant,
  ancestorChain,
  relLabel,
} from "./paths"

describe("detectSep", () => {
  it("uses backslash only for pure-windows paths", () => {
    expect(detectSep("C:\\a\\b")).toBe("\\")
    expect(detectSep("/a/b")).toBe("/")
    expect(detectSep("C:/a/b")).toBe("/") // mixed → posix
  })
})

describe("stripTrailingSep", () => {
  it("drops one trailing separator but preserves roots", () => {
    expect(stripTrailingSep("/a/b/")).toBe("/a/b")
    expect(stripTrailingSep("C:\\a\\")).toBe("C:\\a")
    expect(stripTrailingSep("/")).toBe("/")
    expect(stripTrailingSep("C:\\")).toBe("C:\\")
  })
})

describe("joinPath", () => {
  it("joins using the base separator", () => {
    expect(joinPath("/proj", "a/b.md")).toBe("/proj/a/b.md")
    expect(joinPath("C:\\proj", ".cognia/agents")).toBe("C:\\proj\\.cognia\\agents")
    expect(joinPath("/proj/", "x")).toBe("/proj/x")
  })
})

describe("dirname / basename", () => {
  it("computes parents across platforms", () => {
    expect(dirname("/a/b/c.md")).toBe("/a/b")
    expect(dirname("/foo")).toBe("/")
    expect(dirname("C:\\a\\b")).toBe("C:\\a")
    expect(dirname("C:\\a")).toBe("C:\\")
  })
  it("computes the last segment", () => {
    expect(basename("/a/b/c.md")).toBe("c.md")
    expect(basename("C:\\a\\b\\AGENTS.md")).toBe("AGENTS.md")
    expect(basename("/a/b/")).toBe("b")
  })
})

describe("isRoot", () => {
  it("detects posix and windows roots", () => {
    expect(isRoot("/")).toBe(true)
    expect(isRoot("C:\\")).toBe(true)
    expect(isRoot("/a")).toBe(false)
  })
})

describe("pathKey / isDescendant", () => {
  it("is case-insensitive for windows", () => {
    expect(pathKey("C:\\Proj\\A")).toBe("c:/proj/a")
    expect(pathKey("/Proj/A")).toBe("/Proj/A")
  })
  it("recognises descendants", () => {
    expect(isDescendant("/proj", "/proj/sub/x")).toBe(true)
    expect(isDescendant("/proj", "/proj")).toBe(true)
    expect(isDescendant("/proj", "/projector")).toBe(false)
    expect(isDescendant("C:\\Proj", "c:\\proj\\sub")).toBe(true)
  })
})

describe("ancestorChain", () => {
  it("walks up to the stop boundary, nearest first", () => {
    expect(ancestorChain("/proj/a/b", "/proj")).toEqual(["/proj/a/b", "/proj/a", "/proj"])
  })
  it("walks to fs root when no boundary matches", () => {
    expect(ancestorChain("/a/b")).toEqual(["/a/b", "/a", "/"])
  })
  it("caps depth to avoid whole-disk scans", () => {
    const chain = ancestorChain("/a/b/c/d/e", undefined, 2)
    expect(chain).toEqual(["/a/b/c/d/e", "/a/b/c/d"])
  })
  it("handles windows drive roots", () => {
    expect(ancestorChain("C:\\proj\\a", "C:\\proj")).toEqual(["C:\\proj\\a", "C:\\proj"])
  })
})

describe("edge cases", () => {
  it("stripTrailingSep preserves a posix-style windows drive root", () => {
    expect(stripTrailingSep("C:/")).toBe("C:/")
  })
  it("joinPath with an empty relative returns the trimmed base", () => {
    expect(joinPath("/proj/", "")).toBe("/proj")
  })
  it("dirname returns the input when there is no separator", () => {
    expect(dirname("file.md")).toBe("file.md")
  })
  it("relLabel falls back to basename when child equals root", () => {
    expect(relLabel("/proj", "/proj")).toBe("proj")
  })
})

describe("relLabel", () => {
  it("returns the relative path under the root", () => {
    expect(relLabel("/proj", "/proj/sub/AGENT.md")).toBe("sub/AGENT.md")
    expect(relLabel("/proj", "/proj/CLAUDE.md")).toBe("CLAUDE.md")
  })
  it("falls back to basename when outside the root", () => {
    expect(relLabel("/proj", "/other/CLAUDE.md")).toBe("CLAUDE.md")
    expect(relLabel(undefined, "/x/AGENTS.md")).toBe("AGENTS.md")
  })
})
