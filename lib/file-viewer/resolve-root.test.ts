import { resolveViewerTarget } from "./resolve-root"

describe("resolveViewerTarget", () => {
  it("splits an absolute path into its root and a relative remainder", () => {
    expect(resolveViewerTarget("/work/app/src/index.ts", ["/work/app"])).toEqual({
      root: "/work/app",
      relPath: "src/index.ts",
    })
  })

  it("gives a nested worktree its own files rather than the parent checkout's", () => {
    const roots = ["/work/app", "/work/app/vendor/lib"]
    expect(resolveViewerTarget("/work/app/vendor/lib/src/a.ts", roots)).toEqual({
      root: "/work/app/vendor/lib",
      relPath: "src/a.ts",
    })
  })

  it("returns the root as given, not its normalized spelling", () => {
    // The caller passes this straight to the workspace transport, which expects
    // the root it registered.
    expect(resolveViewerTarget("/work/app/a.ts", ["/work/app/"])?.root).toBe("/work/app/")
  })

  it("refuses a path outside every root", () => {
    expect(resolveViewerTarget("/usr/lib/node_modules/x/index.js", ["/work/app"])).toBeNull()
    // A sibling whose name merely starts the same way is not inside it.
    expect(resolveViewerTarget("/work/app-2/a.ts", ["/work/app"])).toBeNull()
  })

  it("refuses a traversal that would escape the root", () => {
    expect(resolveViewerTarget("/work/app/../secrets.txt", ["/work/app"])).toBeNull()
  })

  it("refuses the root itself, which is a directory", () => {
    expect(resolveViewerTarget("/work/app", ["/work/app"])).toBeNull()
    expect(resolveViewerTarget("/work/app/", ["/work/app"])).toBeNull()
  })

  it("refuses an empty root set and an unresolvable path", () => {
    expect(resolveViewerTarget("/work/app/a.ts", [])).toBeNull()
    expect(resolveViewerTarget("", ["/work/app"])).toBeNull()
    // Drive-relative: ambiguous without a current directory.
    expect(resolveViewerTarget("C:app/a.ts", ["C:/work"])).toBeNull()
  })

  it("matches Windows drive paths case-insensitively and accepts UNC roots", () => {
    expect(resolveViewerTarget("C:\\Work\\App\\src\\a.ts", ["c:/work/app"])).toEqual({
      root: "c:/work/app",
      relPath: "src/a.ts",
    })
    expect(resolveViewerTarget("//server/share/app/a.ts", ["//server/share/app"])).toEqual({
      root: "//server/share/app",
      relPath: "a.ts",
    })
  })

  it("ignores unusable entries in the root set", () => {
    expect(resolveViewerTarget("/work/app/a.ts", ["", "   ", "/work/app"])?.root).toBe("/work/app")
  })
})
