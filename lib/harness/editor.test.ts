import { HARNESS_COMPONENT_NAMES } from "@/types/harness/snapshot"
import {
  applyProposal,
  evaluateProposal,
  parseStructuredProposal,
  proposalFromEditedTree,
  runEditorStage,
  type EditProposal,
} from "./editor"
import { makeComponents } from "./test-fixtures"
import { componentsToTree } from "./tree"

const current = makeComponents()
const policy = { editable: HARNESS_COMPONENT_NAMES, knownTools: ["Read", "Bash"] }

describe("parseStructuredProposal", () => {
  it("reads a fenced JSON answer and strips a harness/ prefix", () => {
    const parsed = parseStructuredProposal(
      'Here:\n```json\n{"decision":"edit","notes":"- memory","files":{"harness/memory.md":"x","skills/csv-report/SKILL.md":null}}\n```'
    )
    expect(parsed).toEqual({
      ok: true,
      proposal: {
        decision: "edit",
        notes: "- memory",
        files: { "memory.md": "x", "skills/csv-report/SKILL.md": null },
      },
    })
  })

  it.each([
    ["not json", /not one JSON object/],
    ['{"decision":"maybe"}', /decision must be/],
    ['{"decision":"edit","files":[]}', /files must be an object/],
    ['{"decision":"edit","files":{"a":1}}', /must be a string or null/],
  ])("rejects %s", (text, error) => {
    const parsed = parseStructuredProposal(text)
    expect(!parsed.ok && parsed.error).toMatch(error)
  })
})

describe("proposalFromEditedTree", () => {
  const before = componentsToTree(current)

  it("reads changes off the trees", () => {
    const after: Record<string, string> = { ...before, "memory.md": "new" }
    delete after["guardrails.md"]
    expect(proposalFromEditedTree(before, after, "CHANGED\n- memory")).toEqual({
      decision: "edit",
      notes: "CHANGED\n- memory",
      files: { "memory.md": "new", "guardrails.md": null },
    })
  })

  it("keeps the base when the notes say so or nothing changed", () => {
    expect(
      proposalFromEditedTree(before, { ...before, "memory.md": "x" }, "keep_base").decision
    ).toBe("keep_base")
    expect(proposalFromEditedTree(before, { ...before }, "CHANGED").decision).toBe("keep_base")
  })
})

describe("applyProposal", () => {
  it("applies writes and deletes and reports escaping paths", () => {
    const { tree, escapingPaths } = applyProposal(
      { "memory.md": "a", "guardrails.md": "b" },
      { "./memory.md": "c", "guardrails.md": null, "../x": "evil" }
    )
    expect(tree).toEqual({ "memory.md": "c" })
    expect(escapingPaths).toEqual(["../x"])
  })
})

describe("evaluateProposal", () => {
  const edit = (files: EditProposal["files"]): EditProposal => ({
    decision: "edit",
    notes: "",
    files,
  })

  it("accepts a valid change", () => {
    const result = evaluateProposal(
      edit({ "memory.md": "Reports go in report.md.\nUse ; separators." }),
      current,
      policy
    )
    expect(result.kind).toBe("valid")
    expect(result.kind === "valid" && result.components.memory).toContain("Use ; separators.")
  })

  it("treats keep_base and a no-op edit as keeping the base", () => {
    expect(
      evaluateProposal({ decision: "keep_base", notes: "", files: {} }, current, policy).kind
    ).toBe("keep-base")
    expect(evaluateProposal(edit({ "memory.md": current.memory }), current, policy).kind).toBe(
      "keep-base"
    )
  })

  it("collects parse, surface and validation errors", () => {
    const result = evaluateProposal(
      edit({ "notes.txt": "x", "../a": "y", "systemprompt.md": "" }),
      current,
      policy
    )
    expect(result.kind).toBe("invalid")
    const errors = result.kind === "invalid" ? result.errors.join("\n") : ""
    expect(errors).toMatch(/\.\.\/a: paths must stay inside harness\//)
    expect(errors).toMatch(/notes\.txt: not part of the editable harness/)
    expect(evaluateProposal(edit({ "systemprompt.md": "" }), current, policy).kind).toBe("invalid")
  })
})

describe("runEditorStage", () => {
  it("returns a changed harness on the first valid answer", async () => {
    const attempt = jest.fn().mockResolvedValue({
      ok: true,
      proposal: { decision: "edit", notes: "n", files: { "memory.md": "fact" } },
    })
    const result = await runEditorStage(current, policy, attempt)
    expect(result).toMatchObject({ outcome: "changed", attempts: 1, notes: "n" })
    expect(attempt).toHaveBeenCalledWith(undefined)
  })

  it("feeds validator errors back once, verbatim", async () => {
    const attempt = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        proposal: { decision: "edit", notes: "", files: { "systemprompt.md": " " } },
      })
      .mockResolvedValueOnce({
        ok: true,
        proposal: { decision: "edit", notes: "fixed", files: { "memory.md": "fact" } },
      })
    const result = await runEditorStage(current, policy, attempt)
    expect(result).toMatchObject({ outcome: "changed", attempts: 2 })
    expect(attempt.mock.calls[1][0].join()).toMatch(/never empty it/)
  })

  it("falls back to the input harness after a second invalid answer", async () => {
    const attempt = jest.fn().mockResolvedValue({ ok: false, error: "the answer is not JSON" })
    const result = await runEditorStage(current, policy, attempt)
    expect(result).toEqual({
      outcome: "fell-back",
      components: current,
      notes: "",
      attempts: 2,
      errors: ["the answer is not JSON"],
    })
    expect(attempt).toHaveBeenCalledTimes(2)
  })

  it("records keep-base as a valid outcome", async () => {
    const attempt = jest.fn().mockResolvedValue({
      ok: true,
      proposal: { decision: "keep_base", notes: "fine", files: {} },
    })
    expect(await runEditorStage(current, policy, attempt)).toMatchObject({
      outcome: "kept",
      attempts: 1,
    })
  })

  it("lets a session failure propagate instead of counting it as a proposal", async () => {
    const attempt = jest.fn().mockRejectedValue(new Error("provider down"))
    await expect(runEditorStage(current, policy, attempt)).rejects.toThrow("provider down")
  })
})
