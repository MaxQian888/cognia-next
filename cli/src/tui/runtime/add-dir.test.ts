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

it("localizes directory configuration outcomes without promising external access", () => {
  const deps = { ...base, config: { locale: "zh-CN" as const, additionalRoots: [ABS] } }
  expect(computeAddDir("list", "", deps).message).toContain("额外目录")
  expect(computeAddDir("list", "", { ...deps, config: { locale: "zh-CN" } }).message).toContain(
    "尚未配置"
  )
  expect(computeAddDir("add", "sub", deps)).toMatchObject({
    roots: [ABS, SUB],
    message: expect.stringContaining("实际访问取决于当前 Agent 及其权限"),
  })
  expect(computeAddDir("add", ABS, deps).message).toContain("目录已添加")
  expect(computeAddDir("add", "/invalid", deps).message).toContain("不是有效目录")
  expect(computeAddDir("remove", "/invalid", deps).message).toContain("此目录未添加")
  expect(computeAddDir("remove", "1", deps)).toMatchObject({
    roots: [],
    message: `已移除 ${ABS}。`,
  })
  expect(computeAddDir("add", "", deps).message).toContain("用法：/add-dir <path>")
  expect(computeAddDir("remove", "", deps).message).toContain("用法：/add-dir remove")
  expect(computeAddDir("add", "sub", { ...base, config: {} }).message).toContain(
    "Access depends on the active agent and its permissions"
  )
})
