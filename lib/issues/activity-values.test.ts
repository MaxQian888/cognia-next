import { activityValues } from "./activity-values"

const t = (key: string) => `T:${key}`

describe("activityValues", () => {
  it("localizes a status transition through the status catalogue", () => {
    expect(activityValues({ kind: "status_changed", from: "todo", to: "done" }, t)).toEqual({
      from: "T:status.todo",
      to: "T:status.done",
    })
  })

  it("localizes a priority transition through the priority catalogue", () => {
    expect(activityValues({ kind: "priority_changed", from: "low", to: "high" }, t)).toEqual({
      from: "T:priority.low",
      to: "T:priority.high",
    })
  })

  it("passes other strings through verbatim", () => {
    expect(activityValues({ kind: "title_changed", from: "Old", to: "New" }, t)).toEqual({
      from: "Old",
      to: "New",
    })
  })

  it("prefers an actor's own label and falls back to its kind", () => {
    expect(
      activityValues(
        { kind: "reassigned", from: { kind: "agent" }, to: { kind: "human", label: "Ada" } },
        t
      )
    ).toEqual({ from: "T:actor.agent", to: "Ada" })
  })

  it("resolves an absent half to an empty string, never undefined", () => {
    // ICU prints the literal placeholder for a missing argument, so a
    // `created` event would otherwise render "{to}" to the user.
    expect(activityValues({ kind: "created" }, t)).toEqual({ from: "", to: "" })
  })

  it("survives an event whose payload is missing entirely", () => {
    // These rows cross the companion wire now, so a host on an older shape
    // can hand a phone an event this code does not recognise. A timeline is
    // not worth taking the whole detail sheet down for.
    expect(activityValues(undefined, t)).toEqual({ from: "", to: "" })
    expect(activityValues(null, t)).toEqual({ from: "", to: "" })
  })
})
