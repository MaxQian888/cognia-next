// Coverage for the workspace-trust gate.

import "fake-indexeddb/auto"
import {
  isWorkspaceTrusted,
  listTrustedWorkspaces,
  revokeWorkspaceTrust,
  trustWorkspace,
} from "./trusted-workspaces"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().trustedWorkspaces.clear()
})

describe("trustWorkspace + isWorkspaceTrusted", () => {
  it("round-trips a path", async () => {
    await trustWorkspace("/home/user/project", "monorepo root")
    expect(await isWorkspaceTrusted("/home/user/project")).toBe(true)
    const stored = await getDb().trustedWorkspaces.get("/home/user/project")
    expect(stored?.note).toBe("monorepo root")
    expect(typeof stored?.trustedAt).toBe("number")
  })

  it("normalises trailing forward and back slashes", async () => {
    await trustWorkspace("/home/user/project///")
    expect(await isWorkspaceTrusted("/home/user/project")).toBe(true)
    await trustWorkspace("C:\\Users\\me\\proj\\\\")
    expect(await isWorkspaceTrusted("C:\\Users\\me\\proj")).toBe(true)
  })

  it("returns false for empty paths without throwing", async () => {
    expect(await isWorkspaceTrusted("")).toBe(false)
  })

  it("trustWorkspace silently ignores empty path", async () => {
    await trustWorkspace("")
    expect((await listTrustedWorkspaces()).length).toBe(0)
  })

  it("returns false for unknown paths", async () => {
    expect(await isWorkspaceTrusted("/never/seen")).toBe(false)
  })
})

describe("listTrustedWorkspaces", () => {
  it("orders most-recently-trusted first", async () => {
    await trustWorkspace("/a")
    await new Promise((r) => setTimeout(r, 5))
    await trustWorkspace("/b")
    await new Promise((r) => setTimeout(r, 5))
    await trustWorkspace("/c")
    const all = await listTrustedWorkspaces()
    expect(all.map((w) => w.path)).toEqual(["/c", "/b", "/a"])
  })
})

describe("revokeWorkspaceTrust", () => {
  it("removes the trust row by path", async () => {
    await trustWorkspace("/a")
    await revokeWorkspaceTrust("/a")
    expect(await isWorkspaceTrusted("/a")).toBe(false)
  })

  it("normalises before deletion", async () => {
    await trustWorkspace("/a/")
    await revokeWorkspaceTrust("/a")
    expect(await isWorkspaceTrusted("/a")).toBe(false)
  })

  it("ignores empty path", async () => {
    await trustWorkspace("/a")
    await revokeWorkspaceTrust("")
    expect(await isWorkspaceTrusted("/a")).toBe(true)
  })
})
