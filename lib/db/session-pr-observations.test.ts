/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import { getDb } from "./schema"
import {
  deleteSessionPrObservation,
  getSessionPrObservation,
  listSessionPrObservationsByProject,
  recordSessionPrObservation,
  type SessionPrObservationRow,
} from "./session-pr-observations"

const row = (sessionId: string, projectId = "p1"): SessionPrObservationRow => ({
  id: sessionId,
  sessionId,
  projectId,
  prUrl: `https://github.com/o/n/pull/${sessionId.length}`,
  branch: `thread/${sessionId}`,
  repo: "o/n",
  facts: {} as SessionPrObservationRow["facts"],
  derivedStatus: "pr_open",
  lastNudgeSignature: {} as SessionPrObservationRow["lastNudgeSignature"],
  observedAt: 1,
  updatedAt: 1,
})

beforeEach(async () => {
  await getDb().sessionPrObservations.clear()
})

describe("session PR observations", () => {
  it("records, reads, lists by workspace and deletes", async () => {
    await recordSessionPrObservation(row("t1"))
    await recordSessionPrObservation(row("t2"))
    await recordSessionPrObservation(row("t3", "p2"))
    await recordSessionPrObservation({ ...row("t1"), derivedStatus: "approved" })

    expect((await getSessionPrObservation("t1"))?.derivedStatus).toBe("approved")
    expect((await listSessionPrObservationsByProject("p1")).map((r) => r.id).sort()).toEqual([
      "t1",
      "t2",
    ])
    await deleteSessionPrObservation("t1")
    expect(await getSessionPrObservation("t1")).toBeUndefined()
  })
})
