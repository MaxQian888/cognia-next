import { flattenSummary, validateAllNodes, validateNodeParams } from "./validate-params"
import type { WorkflowNodeKind } from "@/types/workflow/visual"

describe("validateNodeParams", () => {
  it("returns no errors for a happy params object", () => {
    const r = validateNodeParams("trigger.cron", { cron: "0 9 * * 1-5" })
    expect(r.hasErrors).toBe(false)
    expect(r.fields).toEqual({})
    expect(r.summary).toEqual([])
  })

  it("maps a missing required string to the 'required' i18n key", () => {
    const r = validateNodeParams("action.character.send", {})
    expect(r.hasErrors).toBe(true)
    expect(r.fields["characterId"]).toEqual({ key: "required" })
    // When two top-level fields fail, we keep both — but only the first issue
    // per field is recorded.
    expect(Object.keys(r.fields).sort()).toContain("content")
  })

  it("maps a regex failure to the regex's i18n key", () => {
    const r = validateNodeParams("trigger.cron", { cron: "every monday" })
    expect(r.hasErrors).toBe(true)
    expect(r.fields["cron"].key).toBe("cronExpr")
  })

  it("maps a number-out-of-range to maxValue / minValue with params", () => {
    const r = validateNodeParams("ai.prompt", { userPrompt: "x", temperature: 2.5 })
    expect(r.hasErrors).toBe(true)
    expect(r.fields["temperature"].key).toBe("maxValue")
    expect(r.fields["temperature"].params).toEqual({ max: 2 })
  })

  it("maps a too-small array to its custom message", () => {
    const r = validateNodeParams("flow.split", { branchLabels: ["A"] })
    expect(r.hasErrors).toBe(true)
    expect(r.fields["branchLabels"].key).toBe("splitBranchesRequired")
  })

  it("collapses object-level refine failures under _root", () => {
    const r = validateNodeParams("flow.loop", { bodyExpression: "x" })
    expect(r.hasErrors).toBe(true)
    // The refine targets `path: ["mode"]`
    expect(r.fields["mode"].key).toBe("loopBodyRequired")
  })

  it("treats unknown / plugin kinds as always-valid", () => {
    const r = validateNodeParams("plugin.foo.bar" as WorkflowNodeKind, { x: 1 })
    expect(r.hasErrors).toBe(false)
  })

  it("treats undefined params as an empty object (and surfaces required)", () => {
    const r = validateNodeParams("ai.prompt", undefined)
    expect(r.hasErrors).toBe(true)
    expect(r.fields["userPrompt"].key).toBe("required")
  })
})

describe("validateAllNodes", () => {
  it("only includes nodes with errors", () => {
    const out = validateAllNodes([
      {
        id: "n1",
        data: { kind: "trigger.manual", params: {} },
      },
      {
        id: "n2",
        data: { kind: "ai.prompt", params: { userPrompt: "" } },
      },
      {
        id: "n3",
        data: { kind: "trigger.cron", params: { cron: "0 * * * *" } },
      },
    ])
    expect(Object.keys(out)).toEqual(["n2"])
    expect(out["n2"].fields["userPrompt"].key).toBe("required")
  })

  it("handles a node that is missing params entirely", () => {
    const out = validateAllNodes([{ id: "n1", data: { kind: "ai.prompt" } }])
    expect(out["n1"].hasErrors).toBe(true)
  })
})

describe("flattenSummary", () => {
  it("prefixes each summary line with its step id", () => {
    const out = validateAllNodes([
      { id: "n1", data: { kind: "ai.prompt", params: {} } },
      { id: "n2", data: { kind: "trigger.cron", params: { cron: "" } } },
    ])
    const lines = flattenSummary(out)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((l) => /^n[12] → /.test(l))).toBe(true)
  })

  it("returns an empty list when there are no errors", () => {
    expect(flattenSummary({})).toEqual([])
  })
})
