import type { IssueEvent } from "@/types/issues"
import { syncActorFor } from "@/types/issues"
import { lastLocalChangeAt, syncFieldOfEvent } from "./field-clock"

const HUMAN = { kind: "human" as const }

function event(
  kind: IssueEvent["kind"],
  ts: number,
  by: import("@/types/issues").IssueActor = HUMAN
): IssueEvent {
  return {
    id: `e${ts}`,
    issueId: "i1",
    kind,
    ts,
    payload: { kind, by } as unknown as IssueEvent["payload"],
  }
}

describe("syncFieldOfEvent", () => {
  it("maps every editing event kind to its field and nothing else", () => {
    expect(syncFieldOfEvent("title_changed")).toBe("title")
    expect(syncFieldOfEvent("reassigned")).toBe("assignee")
    expect(syncFieldOfEvent("label_removed")).toBe("labels")
    expect(syncFieldOfEvent("cycle_changed")).toBe("cycle")
    expect(syncFieldOfEvent("created")).toBeUndefined()
    expect(syncFieldOfEvent("commented")).toBeUndefined()
    expect(syncFieldOfEvent("synced_in")).toBeUndefined()
  })
})

describe("lastLocalChangeAt", () => {
  it("keeps the newest change per field after the watermark", () => {
    const clock = lastLocalChangeAt(
      [
        event("created", 1),
        event("title_changed", 5),
        event("title_changed", 9),
        event("priority_changed", 7),
        event("label_added", 3),
      ],
      4
    )
    expect([...clock.entries()]).toEqual([
      ["title", 9],
      ["priority", 7],
    ])
  })

  it("ignores the sync engine's own writes", () => {
    const clock = lastLocalChangeAt(
      [event("title_changed", 5, syncActorFor("github")), event("status_changed", 6)],
      0
    )
    expect([...clock.keys()]).toEqual(["status"])
  })

  it("treats the watermark as exclusive", () => {
    expect(lastLocalChangeAt([event("title_changed", 5)], 5).size).toBe(0)
  })
})
