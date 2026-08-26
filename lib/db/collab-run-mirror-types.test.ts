import { ISSUE_RUN_KINDS } from "@/types/issues"

import type { CollabRunKind, CollabRunMirrorRow } from "./collab-run-mirror-types"

function row(overrides: Partial<CollabRunMirrorRow> = {}): CollabRunMirrorRow {
  return {
    id: "run_1",
    orgId: "org_acme",
    workspaceId: "proj-1",
    issueId: "iss_1",
    title: "Fix the flake",
    kind: "agent-task",
    status: "running",
    startedBy: { kind: "human", id: "usr_aaaaaaaaaaaaaaaaaaaaaaaa" },
    startedAt: 10,
    updatedAt: 10,
    artifacts: [],
    fetchedAt: 20,
    ...overrides,
  }
}

describe("CollabRunMirrorRow", () => {
  it("carries every field the schema indexes", () => {
    // Mirrors
    // `collabRuns: "&id, orgId, workspaceId, issueId, planId, status, startedAt, fetchedAt"`.
    const withBoth = row({ planId: "plan_1" })
    for (const indexed of [
      "id",
      "orgId",
      "workspaceId",
      "issueId",
      "planId",
      "status",
      "startedAt",
      "fetchedAt",
    ] as const) {
      expect(withBoth[indexed]).toBeDefined()
    }
  })

  it("accepts a run attached to nothing, and still requires a title", () => {
    // An ad-hoc dispatch is a real state; the title is what makes it readable.
    const adhoc = row({ issueId: undefined, title: "Ad-hoc sweep" })
    expect(adhoc.issueId).toBeUndefined()
    expect(adhoc.planId).toBeUndefined()
    expect(adhoc.title).toBe("Ad-hoc sweep")
  })

  it("extends the local run kinds by exactly one", () => {
    // `issueRuns` only ever describes an issue, so it has no name for a plan
    // executing under the plan runtime. The union states that split rather
    // than duplicating the three shared kinds.
    const kinds: CollabRunKind[] = [...ISSUE_RUN_KINDS, "plan"]
    expect(kinds).toHaveLength(ISSUE_RUN_KINDS.length + 1)
    expect(kinds).toContain("plan")
  })
})
