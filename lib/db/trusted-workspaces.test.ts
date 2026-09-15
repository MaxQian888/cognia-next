// Coverage for the workspace-trust gate.

import {
  approveEnvironmentDeclaration,
  approveWorkspaceConfig,
  getTrustedWorkspace,
  isWorkspaceTrusted,
  listTrustedWorkspaces,
  revokeEnvironmentApproval,
  revokeWorkspaceTrust,
  trustWorkspace,
} from "./trusted-workspaces"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().trustedWorkspaces.clear()
})
afterAll(dbFixture.dispose)

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

describe("environment declaration approval", () => {
  const approval = {
    declarationDigest: "a".repeat(64),
    file: "devcontainer" as const,
    path: ".devcontainer/devcontainer.json",
    resolvedImage: {
      registry: "docker.io",
      repository: "library/python",
      digest: `sha256:${"b".repeat(64)}`,
    },
  }

  it("stores the approval beside, not over, the workspace.json approval", async () => {
    await trustWorkspace("/repo")
    await approveWorkspaceConfig("/repo", "c".repeat(64))
    expect(await approveEnvironmentDeclaration("/repo/", approval)).toBe(true)

    const row = await getTrustedWorkspace("/repo")
    expect(row?.approvedConfigDigest).toBe("c".repeat(64))
    expect(row?.approvedEnvironment).toEqual({ ...approval, approvedAt: expect.any(Number) })
  })

  it("keeps only the pinned image fields", async () => {
    await trustWorkspace("/repo")
    await approveEnvironmentDeclaration("/repo", {
      ...approval,
      resolvedImage: { ...approval.resolvedImage, tag: "3.12-slim" } as never,
    })
    expect((await getTrustedWorkspace("/repo"))?.approvedEnvironment?.resolvedImage).toEqual(
      approval.resolvedImage
    )
  })

  it("refuses an untrusted root, a malformed digest and an unpinned image", async () => {
    expect(await approveEnvironmentDeclaration("/repo", approval)).toBe(false)
    expect(await getTrustedWorkspace("/repo")).toBeUndefined()

    await trustWorkspace("/repo")
    for (const bad of [
      { ...approval, declarationDigest: "A".repeat(64) },
      { ...approval, path: "" },
      { ...approval, resolvedImage: { ...approval.resolvedImage, digest: "3.12-slim" } },
    ]) {
      expect(await approveEnvironmentDeclaration("/repo", bad)).toBe(false)
    }
    expect(await approveEnvironmentDeclaration("", approval)).toBe(false)
    expect((await getTrustedWorkspace("/repo"))?.approvedEnvironment).toBeUndefined()
  })

  it("revokes the environment approval and keeps folder trust", async () => {
    await trustWorkspace("/repo")
    await approveWorkspaceConfig("/repo", "c".repeat(64))
    await approveEnvironmentDeclaration("/repo", approval)

    expect(await revokeEnvironmentApproval("/repo/")).toBe(true)
    const row = await getTrustedWorkspace("/repo")
    expect(row).toBeDefined()
    expect(row).not.toHaveProperty("approvedEnvironment")
    expect(row?.approvedConfigDigest).toBe("c".repeat(64))
    expect(await revokeEnvironmentApproval("/repo")).toBe(false)
    expect(await revokeEnvironmentApproval("")).toBe(false)
  })

  it("drops the approval with the trust row", async () => {
    await trustWorkspace("/repo")
    await approveEnvironmentDeclaration("/repo", approval)
    await revokeWorkspaceTrust("/repo")
    await trustWorkspace("/repo")
    expect((await getTrustedWorkspace("/repo"))?.approvedEnvironment).toBeUndefined()
  })
})
