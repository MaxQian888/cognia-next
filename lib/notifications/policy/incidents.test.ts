// Coverage for incident + inhibition (V2): the pure `shouldFoldIntoIncident`
// correlation and `incidentFactKey`, plus the open → acknowledge → resolve
// lifecycle over the policy-state table. fake-indexeddb exercises the real
// Dexie path for the DB glue.

import {
  shouldFoldIntoIncident,
  incidentFactKey,
  openIncident,
  acknowledgeIncident,
  resolveIncident,
} from "./incidents"
import { listOpenIncidents, getPolicyState } from "@/lib/db/notification-policy-state"
import type { NotificationPolicyStateRow } from "@/types/notifications/decision"
import type { PlannerFact } from "./planner"
import { createDbTestFixture } from "@/lib/db/test-fixture"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const SCOPE = "ns::acct::"

function fact(over: Partial<PlannerFact> = {}): PlannerFact {
  return {
    factKey: over.factKey ?? "run:r1:step-failed",
    category: "incident",
    purpose: "incident-alert",
    level: "warning",
    source: "run",
    ...(over.runId ? { runId: over.runId } : {}),
    ...(over.factKey ? { factKey: over.factKey } : {}),
  }
}

function incidentRow(
  over: Partial<NotificationPolicyStateRow["incident"]> = {}
): NotificationPolicyStateRow {
  return {
    id: "i1",
    scopeKey: SCOPE,
    factKey: "inc1",
    stateKind: "incident",
    incident: {
      rootFactKey: "run:r1:failed",
      memberFactKeys: [],
      state: "open",
      openedAt: 0,
      ...over,
    },
    createdAt: 0,
    updatedAt: 0,
  }
}

describe("shouldFoldIntoIncident", () => {
  it("folds a member sharing the incident's run", () => {
    expect(shouldFoldIntoIncident(incidentRow(), fact({ runId: "r1" }), { runId: "r1" })).toBe(true)
  })

  it("folds a member sharing the group key", () => {
    expect(
      shouldFoldIntoIncident(incidentRow(), fact({ factKey: "run:r1:grp:step-3" }), {
        groupKey: "grp",
      })
    ).toBe(true)
  })

  it("never folds the ROOT fact", () => {
    expect(
      shouldFoldIntoIncident(
        incidentRow({ rootFactKey: "run:r1:failed" }),
        fact({ factKey: "run:r1:failed", runId: "r1" }),
        { runId: "r1" }
      )
    ).toBe(false)
  })

  it("does not fold into a resolved incident", () => {
    expect(
      shouldFoldIntoIncident(incidentRow({ state: "resolved" }), fact({ runId: "r1" }), {
        runId: "r1",
      })
    ).toBe(false)
  })

  it("does not fold an uncorrelated fact (conservative — no over-fold)", () => {
    expect(shouldFoldIntoIncident(incidentRow(), fact({ runId: "other" }), { runId: "r1" })).toBe(
      false
    )
  })

  it("returns false for a non-incident row", () => {
    const notIncident = { ...incidentRow(), incident: undefined } as NotificationPolicyStateRow
    expect(shouldFoldIntoIncident(notIncident, fact(), {})).toBe(false)
  })
})

describe("incidentFactKey", () => {
  it("is deterministic for the same scope+root", () => {
    expect(incidentFactKey(SCOPE, "run:r1:failed")).toBe(incidentFactKey(SCOPE, "run:r1:failed"))
  })

  it("differs for a different root or scope", () => {
    expect(incidentFactKey(SCOPE, "run:r1:failed")).not.toBe(
      incidentFactKey(SCOPE, "run:r2:failed")
    )
    expect(incidentFactKey(SCOPE, "run:r1:failed")).not.toBe(
      incidentFactKey("other::x::", "run:r1:failed")
    )
  })
})

describe("incident lifecycle", () => {
  it("opens an incident rooted at a fact and folds members", async () => {
    const row = await openIncident({
      scopeKey: SCOPE,
      rootFactKey: "run:r1:failed",
      memberFactKeys: ["run:r1:step-failed", "run:r1:failed"],
      now: 100,
    })
    expect(row.incident?.state).toBe("open")
    // The root is never recorded as a member.
    expect(row.incident?.memberFactKeys).toEqual(["run:r1:step-failed"])
    const open = await listOpenIncidents(SCOPE)
    expect(open).toHaveLength(1)
  })

  it("extends an existing open incident with new members", async () => {
    await openIncident({
      scopeKey: SCOPE,
      rootFactKey: "run:r1:failed",
      memberFactKeys: ["a"],
      now: 1,
    })
    const again = await openIncident({
      scopeKey: SCOPE,
      rootFactKey: "run:r1:failed",
      memberFactKeys: ["b"],
      now: 2,
    })
    expect(again.incident?.memberFactKeys.sort()).toEqual(["a", "b"])
    expect(again.incident?.openedAt).toBe(1) // keeps the original open instant
  })

  it("acknowledges an open incident", async () => {
    await openIncident({ scopeKey: SCOPE, rootFactKey: "run:r1:failed", now: 1 })
    const acked = await acknowledgeIncident(SCOPE, "run:r1:failed", "operator", 200)
    expect(acked?.incident?.state).toBe("acknowledged")
    expect(acked?.incident?.acknowledgedAt).toBe(200)
    expect(acked?.incident?.ackedBy).toBe("operator")
  })

  it("resolves an incident — releases it from the open set", async () => {
    await openIncident({ scopeKey: SCOPE, rootFactKey: "run:r1:failed", now: 1 })
    await resolveIncident(SCOPE, "run:r1:failed", 300)
    const open = await listOpenIncidents(SCOPE)
    expect(open).toHaveLength(0)
    const row = await getPolicyState(SCOPE, incidentFactKey(SCOPE, "run:r1:failed"), "incident")
    expect(row?.incident?.state).toBe("resolved")
    expect(row?.incident?.resolvedAt).toBe(300)
  })

  it("returns undefined acking/resolving a nonexistent incident", async () => {
    expect(await acknowledgeIncident(SCOPE, "run:nope:failed", "op")).toBeUndefined()
    expect(await resolveIncident(SCOPE, "run:nope:failed")).toBeUndefined()
  })
})
