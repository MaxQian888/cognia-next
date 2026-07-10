import { isUnsafeRelativePath, joinPluginPath } from "./plugin-file-path"

describe("isUnsafeRelativePath", () => {
  it("allows plain relative subpaths", () => {
    expect(isUnsafeRelativePath("syntaxes/foo.json")).toBe(false)
    expect(isUnsafeRelativePath("./themes/dark.json")).toBe(false)
  })

  it("blocks traversal, absolute paths, and drive letters", () => {
    expect(isUnsafeRelativePath("../outside.json")).toBe(true)
    expect(isUnsafeRelativePath("a/../../b.json")).toBe(true)
    expect(isUnsafeRelativePath("/etc/passwd")).toBe(true)
    expect(isUnsafeRelativePath("C:\\windows\\evil.json")).toBe(true)
    expect(isUnsafeRelativePath("")).toBe(true)
  })
})

describe("joinPluginPath", () => {
  it("joins with exactly one separator", () => {
    expect(joinPluginPath("/plugins/p1", "a/b.json")).toBe("/plugins/p1/a/b.json")
    expect(joinPluginPath("/plugins/p1/", "a/b.json")).toBe("/plugins/p1/a/b.json")
  })
})
