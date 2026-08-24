import { locateWorkspaceForPath, unclaimedPaths, workspaceIdForPath } from "./locate-workspace"

function project(id: string, ...paths: string[]) {
  return {
    id,
    roots: paths.map((path, index) => ({
      id: `${id}-r${index}`,
      path,
      isPrimary: index === 0,
    })),
  }
}

const outer = project("outer", "/src/app")
const inner = project("inner", "/src/app/packages/sdk")
const other = project("other", "/work/site", "/work/site-docs")

describe("locateWorkspaceForPath", () => {
  it("finds the workspace whose root contains the path", () => {
    expect(locateWorkspaceForPath("/src/app/lib/db.ts", [outer])?.project.id).toBe("outer")
  })

  it("prefers the deepest root when checkouts nest", () => {
    const found = locateWorkspaceForPath("/src/app/packages/sdk/src/index.ts", [outer, inner])
    expect(found?.project.id).toBe("inner")
  })

  it("does not depend on the order the projects arrive in", () => {
    expect(
      locateWorkspaceForPath("/src/app/packages/sdk/src/index.ts", [inner, outer])?.project.id
    ).toBe("inner")
  })

  it("reports the specific root that matched", () => {
    expect(locateWorkspaceForPath("/work/site-docs/readme.md", [other])?.root.path).toBe(
      "/work/site-docs"
    )
  })

  it("distinguishes the root itself from something inside it", () => {
    expect(locateWorkspaceForPath("/src/app", [outer])?.isRootItself).toBe(true)
    expect(locateWorkspaceForPath("/src/app/lib", [outer])?.isRootItself).toBe(false)
  })

  it("tolerates a trailing separator on either side", () => {
    expect(locateWorkspaceForPath("/src/app/", [outer])?.project.id).toBe("outer")
    expect(locateWorkspaceForPath("/src/app/lib", [project("p", "/src/app/")])?.project.id).toBe(
      "p"
    )
  })

  it("does not match a sibling that merely shares a prefix", () => {
    // `/src/app-legacy` is not inside `/src/app`.
    expect(locateWorkspaceForPath("/src/app-legacy/lib", [outer])).toBeNull()
  })

  it("matches Windows paths case-insensitively", () => {
    const win = project("win", "C:\\Users\\me\\repo")
    expect(locateWorkspaceForPath("c:\\users\\me\\repo\\src", [win])?.project.id).toBe("win")
  })

  it("returns null for a path no workspace claims", () => {
    expect(locateWorkspaceForPath("/elsewhere", [outer, inner])).toBeNull()
  })

  it("returns null for a blank or missing path rather than matching by accident", () => {
    expect(locateWorkspaceForPath("", [outer])).toBeNull()
    expect(locateWorkspaceForPath("   ", [outer])).toBeNull()
    expect(locateWorkspaceForPath(null, [outer])).toBeNull()
    expect(locateWorkspaceForPath(undefined, [outer])).toBeNull()
  })

  it("skips a root with no path", () => {
    const broken = { id: "broken", roots: [{ id: "r", path: "", isPrimary: true }] }
    expect(locateWorkspaceForPath("/anything", [broken])).toBeNull()
  })

  it("tolerates a workspace with no roots at all", () => {
    const empty = { id: "empty", roots: [] }
    expect(locateWorkspaceForPath("/src/app/x", [empty, outer])?.project.id).toBe("outer")
  })
})

describe("workspaceIdForPath", () => {
  it("returns just the id", () => {
    expect(workspaceIdForPath("/src/app/x", [outer])).toBe("outer")
  })

  it("returns null when nothing claims it", () => {
    expect(workspaceIdForPath("/nope", [outer])).toBeNull()
  })
})

describe("unclaimedPaths", () => {
  it("keeps only the paths no workspace owns", () => {
    expect(unclaimedPaths(["/src/app/lib", "/elsewhere", "/work/site"], [outer, other])).toEqual([
      "/elsewhere",
    ])
  })

  it("de-duplicates spellings of the same path and keeps the first", () => {
    expect(unclaimedPaths(["/a/", "/a"], [])).toEqual(["/a"])
  })

  it("normalizes the trailing separator on what it returns", () => {
    expect(unclaimedPaths(["/a/"], [])).toEqual(["/a"])
  })

  it("drops blanks", () => {
    expect(unclaimedPaths(["", "   ", null, undefined, "/a"], [])).toEqual(["/a"])
  })

  it("is empty when everything is already claimed", () => {
    expect(unclaimedPaths(["/src/app", "/src/app/packages/sdk"], [outer, inner])).toEqual([])
  })
})
