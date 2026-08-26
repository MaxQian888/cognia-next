import type { CollabPlanMirrorRow } from "./collab-plan-mirror-types"

function row(): CollabPlanMirrorRow {
  return {
    id: "plan_1",
    orgId: "org_acme",
    workspaceId: "proj-1",
    title: "Migrate the store",
    status: "executing",
    totalSteps: 3,
    completedSteps: 1,
    createdBy: { kind: "human", id: "usr_aaaaaaaaaaaaaaaaaaaaaaaa" },
    createdAt: 1,
    updatedAt: 2,
    fetchedAt: 3,
  }
}

/**
 * A plain projection with no runtime behaviour, so what is worth pinning is its
 * SHAPE: `lib/db/schema.ts` declares the table against this type, and a field
 * that quietly changed name would leave an index pointing at nothing.
 */
describe("CollabPlanMirrorRow", () => {
  it("carries every field the schema indexes", () => {
    // Mirrors `collabPlans: "&id, orgId, workspaceId, status, updatedAt, fetchedAt"`.
    for (const indexed of [
      "id",
      "orgId",
      "workspaceId",
      "status",
      "updatedAt",
      "fetchedAt",
    ] as const) {
      expect(row()[indexed]).toBeDefined()
    }
  })

  it("holds a header and not a step list", () => {
    // Steps come from the single-plan route and are deliberately not mirrored:
    // one request per plan on every refresh, to fill a detail view that does
    // not exist yet. The counts are what the activity panel renders.
    expect(Object.keys(row())).not.toContain("steps")
    expect(row().totalSteps).toBe(3)
  })

  it("names a human author by a usr_ id", () => {
    // ADR-0149 §10: on a shared plane an anonymous human names nobody.
    expect(row().createdBy.id.startsWith("usr_")).toBe(true)
  })
})
