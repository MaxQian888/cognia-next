import {
  bulkUpsertApps,
  deleteAllUserApps,
  deleteApp,
  getApp,
  listApps,
  patchAppMetadata,
  touchApp,
  upsertApp,
} from "./a2ui-apps"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import type { A2UIAppRow } from "./a2ui-types"

function createRow(id: string, overrides: Partial<A2UIAppRow> = {}): A2UIAppRow {
  return {
    id,
    templateId: "custom",
    name: id,
    createdAt: 1,
    lastModified: 1,
    updatedAt: 1,
    components: {
      root: { id: "root", component: "Column", children: [] },
    },
    dataModel: {},
    rootId: "root",
    ...overrides,
  }
}

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().a2uiApps.clear()
})
afterAll(dbFixture.dispose)

describe("A2UI app persistence", () => {
  it("upserts, lists newest first, and deletes user apps", async () => {
    await upsertApp(createRow("older", { updatedAt: 10 }))
    await upsertApp(createRow("newer", { updatedAt: 20 }))

    expect((await listApps()).map((app) => app.id)).toEqual(["newer", "older"])
    expect((await getApp("older"))?.name).toBe("older")

    await deleteApp("older")
    expect(await getApp("older")).toBeUndefined()
  })

  it("patches metadata without replacing the durable component tree", async () => {
    await upsertApp(createRow("saved", { name: "Before", description: "Old" }))

    const patched = await patchAppMetadata(
      "saved",
      {
        name: "After",
        description: "Updated",
        thumbnail: "data:image/png;base64,AAA",
        lastModified: 30,
      },
      40
    )

    expect(patched).toBe(true)
    expect(await getApp("saved")).toEqual(
      expect.objectContaining({
        name: "After",
        description: "Updated",
        thumbnail: "data:image/png;base64,AAA",
        lastModified: 30,
        updatedAt: 40,
        rootId: "root",
        components: {
          root: { id: "root", component: "Column", children: [] },
        },
      })
    )
  })

  it("returns false instead of creating an incomplete row when metadata target is absent", async () => {
    await expect(patchAppMetadata("missing", { name: "No row" }, 20)).resolves.toBe(false)
    expect(await getApp("missing")).toBeUndefined()
  })

  it("protects built-in apps from metadata patches and deletion", async () => {
    await upsertApp(createRow("built-in", { name: "Built in", isBuiltIn: true }))

    await expect(patchAppMetadata("built-in", { name: "Changed" }, 20)).rejects.toThrow(
      "Cannot modify built-in app built-in"
    )
    await expect(deleteApp("built-in")).rejects.toThrow("Cannot delete built-in app built-in")
    expect((await getApp("built-in"))?.name).toBe("Built in")
  })

  it("protects existing built-ins from single and bulk replacement", async () => {
    await upsertApp(createRow("built-in", { name: "Built in", isBuiltIn: true }))

    await expect(upsertApp(createRow("built-in", { name: "User overwrite" }))).rejects.toThrow(
      "Cannot modify built-in app built-in"
    )
    await expect(
      bulkUpsertApps([
        createRow("new-user", { name: "New user app" }),
        createRow("built-in", { name: "Bulk overwrite" }),
      ])
    ).rejects.toThrow("Cannot modify built-in app built-in")

    expect((await getApp("built-in"))?.name).toBe("Built in")
    expect(await getApp("new-user")).toBeUndefined()
  })

  it("touches usage metadata and bulk-deletes only user apps", async () => {
    await upsertApp(createRow("user"))
    await upsertApp(createRow("built-in", { isBuiltIn: true }))

    await touchApp("user", 50)
    await touchApp("user", 60)
    expect(await getApp("user")).toEqual(expect.objectContaining({ lastUsedAt: 60, usageCount: 2 }))

    await expect(deleteAllUserApps()).resolves.toBe(1)
    expect(await getApp("user")).toBeUndefined()
    expect(await getApp("built-in")).toBeDefined()
  })
})
