import { ISSUE_STATUSES } from "@/types/issues"
import { FULL_ISSUE_CAPABILITIES, READ_ONLY_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import { allowedIssueMoveTargets, canMoveIssue, statusTimestampPatch } from "./state-machine"

const AT_REST = { runActive: false }
const RUNNING = { runActive: true }

describe("canMoveIssue", () => {
  it("allows a same-column drop (reorder) for a local row", () => {
    expect(canMoveIssue(FULL_ISSUE_CAPABILITIES, "todo", "todo", AT_REST)).toEqual({
      allowed: true,
    })
  })

  it("refuses any move on a federated row, including a reorder", () => {
    expect(canMoveIssue(READ_ONLY_ISSUE_CAPABILITIES, "todo", "done", AT_REST)).toEqual({
      allowed: false,
      reason: "federated-read-only",
    })
    expect(canMoveIssue(READ_ONLY_ISSUE_CAPABILITIES, "todo", "todo", AT_REST)).toEqual({
      allowed: false,
      reason: "federated-read-only",
    })
  })

  it("is permissive between human-owned columns at rest", () => {
    for (const from of ISSUE_STATUSES) {
      for (const to of ISSUE_STATUSES) {
        expect(canMoveIssue(FULL_ISSUE_CAPABILITIES, from, to, AT_REST).allowed).toBe(true)
      }
    }
  })

  it("allows re-opening a completed issue", () => {
    expect(canMoveIssue(FULL_ISSUE_CAPABILITIES, "done", "todo", AT_REST).allowed).toBe(true)
  })

  it("locks in_progress in both directions while a run is in flight", () => {
    expect(canMoveIssue(FULL_ISSUE_CAPABILITIES, "in_progress", "done", RUNNING)).toEqual({
      allowed: false,
      reason: "runtime-owned",
    })
    expect(canMoveIssue(FULL_ISSUE_CAPABILITIES, "todo", "in_progress", RUNNING)).toEqual({
      allowed: false,
      reason: "runtime-owned",
    })
  })

  it("still allows reordering inside in_progress while a run is in flight", () => {
    expect(canMoveIssue(FULL_ISSUE_CAPABILITIES, "in_progress", "in_progress", RUNNING)).toEqual({
      allowed: true,
    })
  })

  it("leaves columns unrelated to the run alone while it is in flight", () => {
    expect(canMoveIssue(FULL_ISSUE_CAPABILITIES, "in_review", "done", RUNNING).allowed).toBe(true)
  })
})

describe("allowedIssueMoveTargets", () => {
  it("never includes the issue's own column", () => {
    const targets = allowedIssueMoveTargets(FULL_ISSUE_CAPABILITIES, "todo", AT_REST)
    expect(targets).not.toContain("todo")
    expect(targets).toHaveLength(ISSUE_STATUSES.length - 1)
  })

  it("drops in_progress while a run is in flight", () => {
    const targets = allowedIssueMoveTargets(FULL_ISSUE_CAPABILITIES, "todo", RUNNING)
    expect(targets).not.toContain("in_progress")
  })

  it("is empty for a federated row", () => {
    expect(allowedIssueMoveTargets(READ_ONLY_ISSUE_CAPABILITIES, "todo", AT_REST)).toEqual([])
  })
})

describe("statusTimestampPatch", () => {
  const NOW = 1_000

  it("stamps startedAt on first entry to in_progress and keeps it afterwards", () => {
    expect(statusTimestampPatch("in_progress", NOW, {})).toMatchObject({ startedAt: NOW })
    expect(statusTimestampPatch("in_progress", NOW + 5, { startedAt: 7 })).toMatchObject({
      startedAt: 7,
    })
  })

  it("stamps completedAt on done, back-filling startedAt when it was skipped", () => {
    expect(statusTimestampPatch("done", NOW, {})).toEqual({
      startedAt: NOW,
      completedAt: NOW,
      canceledAt: undefined,
    })
  })

  it("stamps canceledAt and preserves whatever startedAt existed", () => {
    expect(statusTimestampPatch("canceled", NOW, { startedAt: 7 })).toEqual({
      startedAt: 7,
      completedAt: undefined,
      canceledAt: NOW,
    })
  })

  it("clears every lifecycle stamp when an issue is re-opened", () => {
    expect(
      statusTimestampPatch("todo", NOW, { startedAt: 1, completedAt: 2, canceledAt: 3 })
    ).toEqual({ startedAt: undefined, completedAt: undefined, canceledAt: undefined })
    expect(
      statusTimestampPatch("backlog", NOW, { startedAt: 1, completedAt: 2, canceledAt: 3 })
    ).toEqual({ startedAt: undefined, completedAt: undefined, canceledAt: undefined })
  })

  it("clears a stale completedAt when moving back into review", () => {
    expect(statusTimestampPatch("in_review", NOW, { startedAt: 1, completedAt: 2 })).toEqual({
      startedAt: 1,
      completedAt: undefined,
      canceledAt: undefined,
    })
  })
})
