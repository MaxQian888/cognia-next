/**
 * Tests for lib/db/notification-policy-state.ts — the durable, replayable
 * policy evidence. Covers the stateKind-closed rows (decision / incident /
 * approval / escalation), latest-row reads, the open-incident inhibitor set,
 * and the incident lifecycle transition.
 */

import { createDbTestFixture } from "./test-fixture"
import {
  putPolicyState,
  getPolicyState,
  listOpenIncidents,
  transitionIncident,
} from "./notification-policy-state"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const SCOPE = "scope-A"

function decision(factKey: string) {
  return {
    scopeKey: SCOPE,
    factKey,
    stateKind: "decision" as const,
    decision: {
      factKey,
      category: "run.terminal" as const,
      revision: 1,
      routes: [],
      outcome: "notified" as const,
      evidence: { policyVersion: 1, evaluatedAt: 0, inputHash: "h" },
    },
  }
}

function incident(factKey: string, state: "open" | "acknowledged" | "resolved" = "open") {
  return {
    scopeKey: SCOPE,
    factKey,
    stateKind: "incident" as const,
    incident: {
      rootFactKey: `root-${factKey}`,
      memberFactKeys: [factKey],
      state,
      openedAt: 0,
    },
  }
}

describe("putPolicyState + getPolicyState", () => {
  it("persists a decision row and reads the latest for the fact+kind", async () => {
    await putPolicyState(decision("f1"))
    const row = await getPolicyState(SCOPE, "f1", "decision")
    expect(row?.stateKind).toBe("decision")
    expect(row?.factKey).toBe("f1")
  })

  it("returns the latest row when several share the fact+kind", async () => {
    const a = await putPolicyState(decision("f1"))
    const { getDb } = await import("./schema")
    // Force an older updatedAt on the first so the second is latest.
    await getDb().notificationPolicyState.put({ ...a, updatedAt: 1 })
    const b = await putPolicyState(decision("f1"))
    const latest = await getPolicyState(SCOPE, "f1", "decision")
    expect(latest?.id).toBe(b.id)
  })

  it("filters by stateKind — a decision and an incident on one fact stay distinct", async () => {
    await putPolicyState(decision("f1"))
    await putPolicyState(incident("f1"))
    expect((await getPolicyState(SCOPE, "f1", "decision"))?.stateKind).toBe("decision")
    expect((await getPolicyState(SCOPE, "f1", "incident"))?.stateKind).toBe("incident")
  })
})

describe("listOpenIncidents", () => {
  it("returns open + acknowledged incidents, never resolved", async () => {
    await putPolicyState(incident("open-1", "open"))
    await putPolicyState(incident("ack-1", "acknowledged"))
    await putPolicyState(incident("resolved-1", "resolved"))
    await putPolicyState(decision("not-an-incident"))
    const open = await listOpenIncidents(SCOPE)
    const keys = open.map((r) => r.factKey)
    expect(keys).toContain("open-1")
    expect(keys).toContain("ack-1")
    expect(keys).not.toContain("resolved-1")
    expect(keys).not.toContain("not-an-incident")
  })

  it("scopes incidents by scopeKey", async () => {
    await putPolicyState(incident("f1"))
    expect(await listOpenIncidents("other-scope")).toHaveLength(0)
  })
})

describe("transitionIncident", () => {
  it("acknowledges an open incident with ackedBy + timestamp", async () => {
    await putPolicyState(incident("f1"))
    const acked = await transitionIncident(SCOPE, "f1", {
      state: "acknowledged",
      ackedBy: "oncall",
      at: 50,
    })
    expect(acked?.incident?.state).toBe("acknowledged")
    expect(acked?.incident?.acknowledgedAt).toBe(50)
    expect(acked?.incident?.ackedBy).toBe("oncall")
  })

  it("resolves an incident — it leaves the open set", async () => {
    await putPolicyState(incident("f1"))
    const resolved = await transitionIncident(SCOPE, "f1", { state: "resolved", at: 60 })
    expect(resolved?.incident?.state).toBe("resolved")
    expect(resolved?.incident?.resolvedAt).toBe(60)
    expect(await listOpenIncidents(SCOPE)).toHaveLength(0)
  })

  it("returns undefined when the fact has no incident row", async () => {
    expect(await transitionIncident(SCOPE, "nope", { state: "resolved" })).toBeUndefined()
  })
})
