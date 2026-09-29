import type { IssueEvent } from "@/types/issues"
import { collapseActivity } from "./activity-feed"

const failed = (id: string): IssueEvent => ({
  id,
  issueId: "i1",
  kind: "run_failed",
  ts: 1,
  payload: { kind: "run_failed", runId: id, adapterId: "a", error: `boom ${id}` },
})
const comment = (id: string): IssueEvent => ({
  id,
  issueId: "i1",
  kind: "commented",
  ts: 1,
  payload: { kind: "commented", commentId: id, body: "x", by: { kind: "human" } },
})

it("collapses consecutive failures into the first one listed, with a count", () => {
  const rows = collapseActivity([failed("f3"), failed("f2"), comment("c"), failed("f1")])
  expect(rows.map((row) => [row.event.id, row.repeats])).toEqual([
    ["f3", 2],
    ["c", 1],
    ["f1", 1],
  ])
})

it("never collapses other kinds", () => {
  expect(collapseActivity([comment("a"), comment("b")]).map((row) => row.repeats)).toEqual([1, 1])
  expect(collapseActivity([])).toEqual([])
})
