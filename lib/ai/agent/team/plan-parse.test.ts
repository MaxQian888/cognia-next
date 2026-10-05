import { parseProposedPlan } from "./plan-parse"

describe("parseProposedPlan", () => {
  it("reads a fenced JSON block", () => {
    expect(parseProposedPlan('Plan:\n```json\n{"tasks":[1]}\n```')).toEqual({
      ok: true,
      plan: { tasks: [1] },
    })
  })

  it("reads bare JSON", () => {
    expect(parseProposedPlan(' {"a":1} ')).toEqual({ ok: true, plan: { a: 1 } })
  })

  it("refuses empty or unparseable text with a reason", () => {
    expect(parseProposedPlan("   ")).toEqual({ ok: false, reason: "empty plan text" })
    const bad = parseProposedPlan("not json")
    expect(bad.ok).toBe(false)
  })
})
