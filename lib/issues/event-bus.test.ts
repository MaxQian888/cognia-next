import type { IssueEvent } from "@/types/issues"
import { emitIssueEvent, onIssueEvent } from "./event-bus"

function event(over: Partial<IssueEvent> = {}): IssueEvent {
  return {
    id: "e1",
    issueId: "i1",
    kind: "commented",
    ts: 1,
    payload: { kind: "commented", body: "hi", by: { kind: "human" } },
    ...over,
  } as IssueEvent
}

describe("issue event bus", () => {
  it("delivers to every subscriber and stops after dispose", () => {
    const seen: string[] = []
    const off = onIssueEvent((e) => seen.push(e.id))
    emitIssueEvent(event({ id: "a" }))
    off()
    emitIssueEvent(event({ id: "b" }))
    expect(seen).toEqual(["a"])
  })

  it("filters by kind and by issue", () => {
    const seen: string[] = []
    const off = onIssueEvent((e) => seen.push(e.id), { kinds: ["commented"], issueId: "i1" })
    emitIssueEvent(event({ id: "keep" }))
    emitIssueEvent(event({ id: "other-kind", kind: "created" }))
    emitIssueEvent(event({ id: "other-issue", issueId: "i2" }))
    off()
    expect(seen).toEqual(["keep"])
  })

  it("keeps the other subscribers alive when one throws", () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {})
    const seen: string[] = []
    const offA = onIssueEvent(() => {
      throw new Error("boom")
    })
    const offB = onIssueEvent((e) => seen.push(e.id))
    emitIssueEvent(event({ id: "x" }))
    offA()
    offB()
    expect(seen).toEqual(["x"])
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})
