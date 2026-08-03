// Coverage for the teamPrObservations CRUD module — record/get round-trip,
// team-scoped newest-first listing, nudge-signature update, and per-run clear.
// Uses fake-indexeddb so the real Dexie query path runs in memory.

import {
  clearTeamPrObservationsForRun,
  getTeamPrObservation,
  listTeamPrObservationsByTeam,
  recordTeamPrObservation,
  teamPrObservationId,
  updateTeamPrNudgeSignature,
  type TeamPrObservationRow,
} from "./team-pr-observations"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import { unfetchedObservation } from "@/lib/github/pr-observe/types"

// High-version schema; a cold open can cross Jest's default hook timeout under
// coverage instrumentation. Mirror the repo pattern for high-version tables.
jest.setTimeout(30_000)

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
})
afterAll(dbFixture.dispose)

function makeRow(over: Partial<TeamPrObservationRow> = {}): TeamPrObservationRow {
  const runId = over.runId ?? "run-1"
  const prUrl = over.prUrl ?? "https://gh/o/n/pull/1"
  return {
    id: teamPrObservationId(runId, prUrl),
    runId,
    teamId: "team-a",
    teammateId: "m1",
    taskId: "t1",
    prUrl,
    branch: "agent/run-1/m1/t1",
    repo: "o/n",
    facts: unfetchedObservation("o/n", 1),
    derivedStatus: "pr_open",
    lastNudgeSignature: {},
    observedAt: 1,
    updatedAt: 1,
    ...over,
  }
}

describe("teamPrObservationId", () => {
  it("joins run and pr url", () => {
    expect(teamPrObservationId("r", "https://gh/pull/9")).toBe("r:https://gh/pull/9")
  })
})

describe("teamPrObservations CRUD", () => {
  it("records and reads back a row", async () => {
    const row = makeRow()
    await recordTeamPrObservation(row)
    expect(await getTeamPrObservation(row.id)).toEqual(row)
  })

  it("put replaces an existing row (idempotent by id)", async () => {
    await recordTeamPrObservation(makeRow({ derivedStatus: "pr_open" }))
    await recordTeamPrObservation(makeRow({ derivedStatus: "ci_failed" }))
    const got = await getTeamPrObservation(teamPrObservationId("run-1", "https://gh/o/n/pull/1"))
    expect(got?.derivedStatus).toBe("ci_failed")
    expect(await getDb().teamPrObservations.count()).toBe(1)
  })

  it("lists a team's observations newest-first and scoped to the team", async () => {
    await recordTeamPrObservation(
      makeRow({ prUrl: "pr-a", id: teamPrObservationId("run-1", "pr-a"), updatedAt: 10 })
    )
    await recordTeamPrObservation(
      makeRow({ prUrl: "pr-b", id: teamPrObservationId("run-1", "pr-b"), updatedAt: 30 })
    )
    await recordTeamPrObservation(
      makeRow({ prUrl: "pr-c", id: teamPrObservationId("run-1", "pr-c"), updatedAt: 20 })
    )
    await recordTeamPrObservation(
      makeRow({
        teamId: "team-b",
        prUrl: "pr-x",
        id: teamPrObservationId("run-2", "pr-x"),
        runId: "run-2",
      })
    )

    const rows = await listTeamPrObservationsByTeam("team-a")
    expect(rows.map((r) => r.prUrl)).toEqual(["pr-b", "pr-c", "pr-a"])
  })

  it("updates the nudge signature and updatedAt", async () => {
    const row = makeRow()
    await recordTeamPrObservation(row)
    await updateTeamPrNudgeSignature(
      row.id,
      { seen: { "ci:x": "sig" }, attempts: { "ci:x": 1 } },
      99
    )
    const got = await getTeamPrObservation(row.id)
    expect(got?.lastNudgeSignature).toEqual({ seen: { "ci:x": "sig" }, attempts: { "ci:x": 1 } })
    expect(got?.updatedAt).toBe(99)
  })

  it("clears only the given run's observations", async () => {
    await recordTeamPrObservation(
      makeRow({ runId: "run-1", prUrl: "pr-a", id: teamPrObservationId("run-1", "pr-a") })
    )
    await recordTeamPrObservation(
      makeRow({
        runId: "run-2",
        prUrl: "pr-b",
        id: teamPrObservationId("run-2", "pr-b"),
        teamId: "team-b",
      })
    )
    const deleted = await clearTeamPrObservationsForRun("run-1")
    expect(deleted).toBe(1)
    expect(await getDb().teamPrObservations.count()).toBe(1)
    expect((await getDb().teamPrObservations.toArray())[0].runId).toBe("run-2")
  })
})
