import { addMember, addTask, removeMember, removeTask, setLead } from "./edit-proposal"
import type { ProposedTask, ProposedTeammate } from "./types"

const roster = (): ProposedTeammate[] => [
  { name: "Lead", role: "lead", description: "l" },
  { name: "A", role: "teammate", description: "a" },
  { name: "B", role: "teammate", description: "b" },
]
const tasks = (): ProposedTask[] => [
  { title: "t0", description: "", assignedTo: 1, dependencies: [] },
  { title: "t1", description: "", assignedTo: 2, dependencies: [0] },
  { title: "t2", description: "", assignedTo: 0, dependencies: [0, 1] },
]

describe("addMember", () => {
  it("appends a blank teammate without touching the lead", () => {
    const next = addMember(roster())
    expect(next).toHaveLength(4)
    expect(next[3]).toEqual({ name: "", role: "teammate", description: "" })
    expect(next[0].role).toBe("lead")
  })
})

describe("removeMember", () => {
  it("reassigns tasks of the removed member to the lead and shifts later indices", () => {
    const { roster: r, tasks: t } = removeMember(roster(), tasks(), 1)
    expect(r.map((m) => m.name)).toEqual(["Lead", "B"])
    // t0 pointed at removed member 1 → lead 0; t1 pointed at 2 → now 1; t2 stays 0.
    expect(t.map((x) => x.assignedTo)).toEqual([0, 1, 0])
  })

  it("promotes the new index-0 member to lead when the lead is removed", () => {
    const { roster: r } = removeMember(roster(), tasks(), 0)
    expect(r[0].name).toBe("A")
    expect(r[0].role).toBe("lead")
    expect(r[1].role).toBe("teammate")
  })

  it("is a no-op for an out-of-range index or a singleton roster", () => {
    const single: ProposedTeammate[] = [{ name: "Solo", role: "lead", description: "" }]
    expect(removeMember(single, [], 0).roster).toBe(single)
    expect(removeMember(roster(), tasks(), 9).roster).toHaveLength(3)
  })
})

describe("setLead", () => {
  it("moves the chosen member to index 0 and remaps task assignments", () => {
    const { roster: r, tasks: t } = setLead(roster(), tasks(), 2)
    // B becomes lead; order becomes [B, Lead, A].
    expect(r.map((m) => m.name)).toEqual(["B", "Lead", "A"])
    expect(r[0].role).toBe("lead")
    expect(r[1].role).toBe("teammate")
    // old assignedTo [1,2,0] under map {0→1,1→2,2→0} → [2,0,1].
    expect(t.map((x) => x.assignedTo)).toEqual([2, 0, 1])
  })

  it("is a no-op when promoting index 0 or an out-of-range index", () => {
    const r = roster()
    expect(setLead(r, tasks(), 0).roster).toBe(r)
    expect(setLead(r, tasks(), 5).roster).toBe(r)
  })
})

describe("addTask", () => {
  it("appends a blank task assigned to the lead", () => {
    const next = addTask(tasks())
    expect(next).toHaveLength(4)
    expect(next[3]).toEqual({ title: "", description: "", assignedTo: 0, dependencies: [] })
  })
})

describe("removeTask", () => {
  it("drops deps on the removed task and shifts later dep indices down", () => {
    const next = removeTask(tasks(), 0)
    expect(next).toHaveLength(2)
    // old t1 deps [0] → dropped; old t2 deps [0,1] → drop 0, shift 1→0 ⇒ [0].
    expect(next[0].dependencies).toEqual([])
    expect(next[1].dependencies).toEqual([0])
  })

  it("preserves the dependency-index-less-than-own-index invariant", () => {
    const next = removeTask(tasks(), 1)
    // remaining tasks were old #0 and #2; old t2 deps [0,1] → drop 1, keep 0 ⇒ [0].
    next.forEach((t, ownIndex) => {
      t.dependencies.forEach((d) => expect(d).toBeLessThan(ownIndex))
    })
  })

  it("is a no-op for an out-of-range index", () => {
    const t = tasks()
    expect(removeTask(t, 9)).toBe(t)
  })
})
