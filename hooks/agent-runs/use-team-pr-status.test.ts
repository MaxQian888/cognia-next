/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import { renderHook, waitFor } from "@testing-library/react"
import { pickNewestPerTeammate, useTeamPrStatusByTeammate } from "./use-team-pr-status"
import type { TeamPrObservationRow } from "@/lib/db/team-pr-observations"
import { recordTeamPrObservation } from "@/lib/db/team-pr-observations"
import { getDb, whenSeeded, __resetDbForTesting } from "@/lib/db/schema"
import { unfetchedObservation } from "@/lib/github/pr-observe/types"

jest.setTimeout(30_000)

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

function row(over: Partial<TeamPrObservationRow>): TeamPrObservationRow {
  return {
    id: "id",
    runId: "run-1",
    teamId: "team-a",
    teammateId: "m1",
    taskId: "t1",
    prUrl: "pr",
    branch: "b",
    repo: "o/n",
    facts: unfetchedObservation("o/n", 1),
    derivedStatus: "pr_open",
    lastNudgeSignature: {},
    observedAt: 1,
    updatedAt: 1,
    ...over,
  }
}

describe("pickNewestPerTeammate", () => {
  it("keeps the newest row per teammate regardless of input order", () => {
    const map = pickNewestPerTeammate([
      row({ id: "a", teammateId: "m1", updatedAt: 10, derivedStatus: "ci_failed" }),
      row({ id: "b", teammateId: "m1", updatedAt: 30, derivedStatus: "mergeable" }),
      row({ id: "c", teammateId: "m1", updatedAt: 20, derivedStatus: "changes_requested" }),
      row({ id: "d", teammateId: "m2", updatedAt: 5, derivedStatus: "draft" }),
    ])
    expect(map.get("m1")?.derivedStatus).toBe("mergeable")
    expect(map.get("m2")?.derivedStatus).toBe("draft")
    expect(map.size).toBe(2)
  })

  it("is empty for no rows", () => {
    expect(pickNewestPerTeammate([]).size).toBe(0)
  })
})

describe("useTeamPrStatusByTeammate", () => {
  it("live-projects the newest observation per teammate for a team", async () => {
    await recordTeamPrObservation(
      row({
        id: "run-1:pr1",
        teammateId: "m1",
        prUrl: "pr1",
        updatedAt: 10,
        derivedStatus: "ci_failed",
      })
    )
    await recordTeamPrObservation(
      row({
        id: "run-1:pr2",
        teammateId: "m1",
        prUrl: "pr2",
        updatedAt: 20,
        derivedStatus: "mergeable",
      })
    )
    await recordTeamPrObservation(
      row({ id: "run-1:pr3", teammateId: "m2", prUrl: "pr3", updatedAt: 5, derivedStatus: "draft" })
    )

    const { result } = renderHook(() => useTeamPrStatusByTeammate("team-a"))
    await waitFor(() => expect(result.current.size).toBe(2))
    expect(result.current.get("m1")?.derivedStatus).toBe("mergeable")
    expect(result.current.get("m2")?.derivedStatus).toBe("draft")
  })
})
