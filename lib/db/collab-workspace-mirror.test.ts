import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import {
  clearCollabWorkspaces,
  getCollabWorkspace,
  listCollabWorkspaces,
  replaceCollabWorkspaces,
} from "./collab-workspace-mirror"
import type { CollabWorkspaceMirrorRow } from "./collab-workspace-mirror-types"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().collabWorkspaces.clear()
})
afterAll(dbFixture.dispose)

function row(overrides: Partial<CollabWorkspaceMirrorRow> = {}): CollabWorkspaceMirrorRow {
  return {
    id: "proj-1",
    orgId: "org_acme",
    name: "Mercury",
    createdAt: 1,
    updatedAt: 2,
    fetchedAt: 3,
    ...overrides,
  }
}

describe("collab workspace mirror", () => {
  it("stores and reads back by org", async () => {
    await replaceCollabWorkspaces("org_acme", [row(), row({ id: "proj-2", name: "Venus" })])
    expect((await listCollabWorkspaces("org_acme")).map((entry) => entry.name)).toEqual([
      "Mercury",
      "Venus",
    ])
    expect((await getCollabWorkspace("proj-2"))?.name).toBe("Venus")
  })

  it("drops a workspace the server stopped listing", async () => {
    // The server's answer IS the set: one it no longer lists is one this
    // person can no longer see, and keeping it shows access that is gone.
    await replaceCollabWorkspaces("org_acme", [row(), row({ id: "proj-2", name: "Venus" })])
    await replaceCollabWorkspaces("org_acme", [row()])
    expect(await listCollabWorkspaces("org_acme")).toHaveLength(1)
  })

  it("never lets one org's pull delete another's rows", async () => {
    await replaceCollabWorkspaces("org_acme", [row()])
    await replaceCollabWorkspaces("org_other", [row({ id: "proj-9", orgId: "org_other" })])
    await replaceCollabWorkspaces("org_acme", [])
    expect(await listCollabWorkspaces("org_other")).toHaveLength(1)
  })

  it("clears everything only when asked explicitly", async () => {
    await replaceCollabWorkspaces("org_acme", [row()])
    await clearCollabWorkspaces()
    expect(await listCollabWorkspaces()).toEqual([])
  })
})
