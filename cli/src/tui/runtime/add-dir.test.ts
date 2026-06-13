import path from "node:path"

import { computeAddDir } from "./add-dir"

const SUB = path.resolve("/work", "sub")
const ABS = path.resolve("/abs/dir")

const base = {
  cwd: "/work",
  exists: (p: string) => p === SUB || p === ABS,
  isDir: (p: string) => p === SUB || p === ABS,
}

describe("computeAddDir", () => {
  it("lists nothing when there are no roots", () => {
    expect(computeAddDir("list", "", { ...base, config: {} }).message).toContain(
      "No additional roots"
    )
  })

  it("lists current roots", () => {
    const r = computeAddDir("list", "", { ...base, config: { additionalRoots: ["/a", "/b"] } })
    expect(r.message).toContain("1. /a")
    expect(r.message).toContain("2. /b")
    expect(r.roots).toBeUndefined()
  })

  it("adds a relative dir resolved against cwd", () => {
    const r = computeAddDir("add", "sub", { ...base, config: {} })
    expect(r.roots).toEqual([SUB])
    expect(r.message).toContain(SUB)
  })

  it("adds an absolute dir", () => {
    const r = computeAddDir("add", ABS, { ...base, config: { additionalRoots: ["/x"] } })
    expect(r.roots).toEqual(["/x", ABS])
  })

  it("rejects a non-directory", () => {
    const r = computeAddDir("add", "/nope", { ...base, config: {} })
    expect(r.roots).toBeUndefined()
    expect(r.message).toContain("Not a directory")
  })

  it("rejects a duplicate", () => {
    const r = computeAddDir("add", ABS, { ...base, config: { additionalRoots: [ABS] } })
    expect(r.roots).toBeUndefined()
    expect(r.message).toContain("Already added")
  })

  it("removes by 1-based index", () => {
    const r = computeAddDir("remove", "2", { ...base, config: { additionalRoots: ["/a", "/b"] } })
    expect(r.roots).toEqual(["/a"])
  })

  it("removes by path", () => {
    const r = computeAddDir("remove", "/a", { ...base, config: { additionalRoots: ["/a", "/b"] } })
    expect(r.roots).toEqual(["/b"])
  })

  it("notices when removing an unknown root", () => {
    const r = computeAddDir("remove", "/zzz", { ...base, config: { additionalRoots: ["/a"] } })
    expect(r.roots).toBeUndefined()
    expect(r.message).toContain("Not an added root")
  })

  it("gives usage on a bare add/remove", () => {
    expect(computeAddDir("add", "  ", { ...base, config: {} }).message).toContain("Usage")
    expect(computeAddDir("remove", "", { ...base, config: {} }).message).toContain("Usage")
  })
})
