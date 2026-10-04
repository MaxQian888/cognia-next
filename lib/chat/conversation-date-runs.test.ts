import type { ChatSession } from "@cognia/agent-config-types"

import {
  conversationReorderUnits,
  flattenDateRuns,
  isDateRunHost,
  nestDateRuns,
  replaceReorderUnitSessions,
  sliceGroupRows,
  withDateRuns,
} from "./conversation-date-runs"
import {
  DATE_BUCKET_ORDER,
  type ConversationDateSection,
  type ConversationGroupSection,
  type ConversationSection,
  type DateBucket,
} from "./conversation-list-model"

function row(id: string): ChatSession {
  return { id, title: id, createdAt: 1, updatedAt: 1 }
}

function run(scope: string, bucket: DateBucket, ids: string[]): ConversationDateSection {
  return { kind: "date", bucket, scope, sessions: ids.map(row) }
}

function splitGroup(id: string, runs: Array<[DateBucket, string[]]>): ConversationGroupSection {
  const key = `team:${id}`
  const dateRuns = runs.map(([bucket, ids]) => run(key, bucket, ids))
  return {
    kind: "group",
    axis: "team",
    group: { id, name: id },
    collapsed: false,
    dateRuns,
    sessions: dateRuns.flatMap((r) => r.sessions),
  }
}

const ids = (sessions: readonly ChatSession[]) => sessions.map((s) => s.id)

describe("conversationReorderUnits", () => {
  it("gives one unit per run for a split group, keyed by run", () => {
    const units = conversationReorderUnits(
      splitGroup("t1", [
        ["today", ["a", "b"]],
        ["older", ["c"]],
      ])
    )
    expect(units.map((u) => [u.key, ids(u.sessions)])).toEqual([
      ["team:t1/date:today", ["a", "b"]],
      ["team:t1/date:older", ["c"]],
    ])
  })

  it("gives the section itself otherwise", () => {
    const pinned: ConversationSection = { kind: "pinned", sessions: [row("p")] }
    expect(conversationReorderUnits(pinned).map((u) => [u.key, ids(u.sessions)])).toEqual([
      ["pinned", ["p"]],
    ])
  })
})

describe("replaceReorderUnitSessions", () => {
  it("replaces one run and keeps the group's flattened rows in step", () => {
    const group = splitGroup("t1", [
      ["today", ["a", "b"]],
      ["older", ["c"]],
    ])
    const next = replaceReorderUnitSessions(group, "team:t1/date:today", [row("b"), row("a")])!
    expect(ids(next.sessions)).toEqual(["b", "a", "c"])
    expect(ids(next.dateRuns![0]!.sessions)).toEqual(["b", "a"])
    // The input is untouched.
    expect(ids(group.sessions)).toEqual(["a", "b", "c"])
  })

  it("returns null for a key the section does not hold", () => {
    const group = splitGroup("t1", [["today", ["a"]]])
    expect(replaceReorderUnitSessions(group, "team:t1", [row("a")])).toBeNull()
    expect(replaceReorderUnitSessions(group, "team:t2/date:today", [row("a")])).toBeNull()
  })

  it("replaces a plain section's rows by its own key", () => {
    const pinned: ConversationSection = { kind: "pinned", sessions: [row("a"), row("b")] }
    const next = replaceReorderUnitSessions(pinned, "pinned", [row("b"), row("a")])!
    expect(ids(next.sessions)).toEqual(["b", "a"])
  })
})

describe("withDateRuns", () => {
  it("drops empty runs and re-flattens", () => {
    const group = splitGroup("t1", [["today", ["a"]]])
    const next = withDateRuns(group, [run("team:t1", "today", []), run("team:t1", "older", ["z"])])
    expect(next.dateRuns!.map((r) => r.bucket)).toEqual(["older"])
    expect(ids(next.sessions)).toEqual(["z"])
  })
})

describe("sliceGroupRows", () => {
  it("cuts the runs at the same row as the flattened list", () => {
    const group = splitGroup("t1", [
      ["today", ["a", "b"]],
      ["yesterday", ["c", "d"]],
      ["older", ["e"]],
    ])
    const sliced = sliceGroupRows(group, 3)
    expect(ids(sliced.sessions)).toEqual(["a", "b", "c"])
    expect(sliced.dateRuns!.map((r) => [r.bucket, ids(r.sessions)])).toEqual([
      ["today", ["a", "b"]],
      ["yesterday", ["c"]],
    ])
  })

  it("slices an unsplit group's rows", () => {
    const group: ConversationGroupSection = {
      kind: "group",
      axis: "team",
      group: { id: "t1", name: "t1" },
      collapsed: false,
      sessions: ["a", "b", "c"].map(row),
    }
    const sliced = sliceGroupRows(group, 2)
    expect(ids(sliced.sessions)).toEqual(["a", "b"])
    expect(sliced.dateRuns).toBeUndefined()
  })

  it("keeps a named row past the cut in its own place and its own run", () => {
    const group = splitGroup("t1", [
      ["today", ["a", "b"]],
      ["yesterday", ["c", "d"]],
      ["older", ["e", "f"]],
    ])
    const sliced = sliceGroupRows(group, 2, "e")
    expect(ids(sliced.sessions)).toEqual(["a", "b", "e"])
    // The kept row brings its own date header; the runs between stay out.
    expect(sliced.dateRuns!.map((r) => [r.bucket, ids(r.sessions)])).toEqual([
      ["today", ["a", "b"]],
      ["older", ["e"]],
    ])
  })

  it("keeps a named row past the cut of an unsplit group", () => {
    const group: ConversationGroupSection = {
      kind: "group",
      axis: "team",
      group: { id: "t1", name: "t1" },
      collapsed: false,
      sessions: ["a", "b", "c", "d"].map(row),
    }
    expect(ids(sliceGroupRows(group, 2, "d").sessions)).toEqual(["a", "b", "d"])
  })

  it("cuts normally when the named row is inside the preview or not in the group", () => {
    const group = splitGroup("t1", [["today", ["a", "b", "c"]]])
    expect(ids(sliceGroupRows(group, 2, "a").sessions)).toEqual(["a", "b"])
    expect(ids(sliceGroupRows(group, 2, "zz").sessions)).toEqual(["a", "b"])
    expect(ids(sliceGroupRows(group, 2, null).sessions)).toEqual(["a", "b"])
  })
})

describe("flattenDateRuns / nestDateRuns", () => {
  const pinned: ConversationSection = { kind: "pinned", sessions: [row("p")] }

  it("round-trips a list with split groups", () => {
    const sections: ConversationSection[] = [
      pinned,
      splitGroup("t1", [
        ["today", ["a"]],
        ["older", ["b"]],
      ]),
      splitGroup("t2", [["yesterday", ["c"]]]),
    ]
    const flat = flattenDateRuns(sections)
    expect(flat.map((s) => s.kind)).toEqual(["pinned", "group", "date", "date", "group", "date"])
    expect(isDateRunHost(flat[1]!)).toBe(true)
    expect(isDateRunHost(flat[0]!)).toBe(false)
    const nested = nestDateRuns(flat, { bucketOrder: DATE_BUCKET_ORDER })
    expect(nested.map((s) => ids(s.sessions))).toEqual([["p"], ["a", "b"], ["c"]])
  })

  it("hands back the same array when nothing is split", () => {
    const sections: ConversationSection[] = [pinned]
    expect(flattenDateRuns(sections)).toBe(sections)
    expect(nestDateRuns(sections, { bucketOrder: DATE_BUCKET_ORDER })).toBe(sections)
  })

  it("gathers a run appended out of place back into its host, in header order", () => {
    // The freeze appends a run it had not seen at the very end of the list.
    const host = { ...splitGroup("t1", []), dateRuns: [], sessions: [] }
    const flat: ConversationSection[] = [
      host,
      run("team:t1", "older", ["b"]),
      pinned,
      run("team:t1", "today", ["a"]),
    ]
    const nested = nestDateRuns(flat, { bucketOrder: DATE_BUCKET_ORDER })
    expect(nested.map((s) => s.kind)).toEqual(["group", "pinned"])
    const group = nested[0] as ConversationGroupSection
    expect(group.dateRuns!.map((r) => r.bucket)).toEqual(["today", "older"])
    const oldestFirst = nestDateRuns(flat, {
      bucketOrder: [...DATE_BUCKET_ORDER].reverse(),
    })[0] as ConversationGroupSection
    expect(oldestFirst.dateRuns!.map((r) => r.bucket)).toEqual(["older", "today"])
  })

  it("drops a host left with no rows unless empty groups are preserved", () => {
    const host = { ...splitGroup("t1", []), dateRuns: [], sessions: [] }
    expect(
      nestDateRuns([host, run("team:t1", "today", [])], { bucketOrder: DATE_BUCKET_ORDER })
    ).toEqual([])
    const kept = nestDateRuns([host, run("team:t1", "today", [])], {
      bucketOrder: DATE_BUCKET_ORDER,
      preserveEmptyGroups: true,
    })
    expect(kept).toHaveLength(1)
    expect((kept[0] as ConversationGroupSection).dateRuns).toEqual([])
  })
})
