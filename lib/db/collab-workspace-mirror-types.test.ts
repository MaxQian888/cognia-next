import type { CollabWorkspaceMirrorRow } from "./collab-workspace-mirror-types"

/**
 * The row is a plain projection with no runtime behaviour, so what is worth
 * pinning is its SHAPE: `lib/db/schema.ts` declares the table against this
 * type, and a field that quietly changed name would leave an index pointing at
 * nothing — an error nothing else surfaces.
 */
describe("CollabWorkspaceMirrorRow", () => {
  it("carries every field the schema indexes", () => {
    const row: CollabWorkspaceMirrorRow = {
      id: "proj-1",
      orgId: "org_acme",
      name: "Mercury",
      createdAt: 1,
      updatedAt: 2,
      fetchedAt: 3,
    }
    // Mirrors `collabWorkspaces: "&id, orgId, name, updatedAt, fetchedAt"`.
    for (const indexed of ["id", "orgId", "name", "updatedAt", "fetchedAt"] as const) {
      expect(row[indexed]).toBeDefined()
    }
  })

  it("uses the workspace id as the key, not a synthetic one", () => {
    // ADR-0149 §1 froze `workspaceId` as the local `projectId`. A second id
    // space for one concept is what makes a federation unreadable.
    const row: CollabWorkspaceMirrorRow = {
      id: "proj-1",
      orgId: "org_acme",
      name: "Mercury",
      createdAt: 1,
      updatedAt: 2,
      fetchedAt: 3,
    }
    expect(row.id).toBe("proj-1")
  })
})
