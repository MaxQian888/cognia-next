import {
  buildLeadReviewPrompt,
  LEAD_REVIEW_SYSTEM_PROMPT,
  leadReviewVerdictSchema,
} from "./lead-review"
import type { ReviewEvidence } from "./review-evidence"

const task = {
  id: "t1",
  title: "Add validation",
  description: "Validate the input",
  expectedOutput: "A patch",
  evidenceIds: ["evidence-diff", "evidence-test"],
}

const commitEvidence: ReviewEvidence = {
  kind: "commit",
  diff: "--- a.ts\n@@ -1 +1 @@\n-a\n+b",
  truncated: false,
  files: ["a.ts"],
}

describe("leadReviewVerdictSchema", () => {
  it("accepts the two verdicts", () => {
    expect(leadReviewVerdictSchema.parse({ verdict: "approved", feedback: "lgtm" }).verdict).toBe(
      "approved"
    )
    expect(
      leadReviewVerdictSchema.parse({ verdict: "changes_requested", feedback: "fix x" }).verdict
    ).toBe("changes_requested")
  })

  it("rejects anything else — an unparseable verdict must not read as approval", () => {
    expect(leadReviewVerdictSchema.safeParse({ verdict: "maybe", feedback: "" }).success).toBe(
      false
    )
    expect(leadReviewVerdictSchema.safeParse({ feedback: "x" }).success).toBe(false)
  })
})

describe("LEAD_REVIEW_SYSTEM_PROMPT", () => {
  it("tells the lead it reviews and cannot edit", () => {
    // The lead is given no tools; a lead that tried to "just fix it" would be
    // landing unreviewed work outside the worker's worktree.
    expect(LEAD_REVIEW_SYSTEM_PROMPT).toMatch(/cannot edit/i)
    expect(LEAD_REVIEW_SYSTEM_PROMPT).toMatch(/json/i)
  })
})

describe("buildLeadReviewPrompt", () => {
  it("carries the task, the deliverable, and the diff", () => {
    const prompt = buildLeadReviewPrompt({
      task,
      workerName: "Coder",
      workerOutput: "I added validation",
      evidence: commitEvidence,
      revision: 0,
    })

    expect(prompt).toContain("Add validation")
    expect(prompt).toContain("Validate the input")
    expect(prompt).toContain("A patch")
    expect(prompt).toContain("Coder")
    expect(prompt).toContain("I added validation")
    expect(prompt).toContain("+b")
    expect(prompt).toContain("```diff")
    expect(prompt).toContain("evidence-diff, evidence-test")
  })

  it("tells the lead when a claim has no diff behind it", () => {
    const prompt = buildLeadReviewPrompt({
      task,
      workerOutput: "I rewrote the parser",
      evidence: { kind: "text", truncated: false, files: [] },
      revision: 0,
    })
    expect(prompt).toMatch(/no diff/i)
    expect(prompt).toMatch(/grounds to request changes/i)
  })

  it("announces truncation so the lead does not judge missing files", () => {
    const prompt = buildLeadReviewPrompt({
      task,
      workerOutput: "done",
      evidence: { ...commitEvidence, truncated: true },
      revision: 0,
    })
    expect(prompt).toMatch(/TRUNCATED/)
    expect(prompt).toMatch(/do not assume the omitted files are wrong/i)
  })

  it("replays its own previous feedback on a revision round", () => {
    const prompt = buildLeadReviewPrompt({
      task,
      workerOutput: "fixed",
      evidence: commitEvidence,
      revision: 1,
      previousFeedback: "Handle the empty case",
    })
    expect(prompt).toContain("revision 1")
    expect(prompt).toContain("Handle the empty case")
    expect(prompt).toMatch(/Verify they were addressed/i)
  })

  it("does not mention revisions on the first review", () => {
    const prompt = buildLeadReviewPrompt({
      task,
      workerOutput: "done",
      evidence: commitEvidence,
      revision: 0,
    })
    expect(prompt).not.toMatch(/revision/i)
  })

  it("caps a runaway deliverable", () => {
    const prompt = buildLeadReviewPrompt({
      task,
      workerOutput: "x".repeat(20000),
      evidence: commitEvidence,
      revision: 0,
    })
    expect(prompt).toContain("[truncated]")
    expect(prompt.length).toBeLessThan(20000)
  })

  it("omits the expected-output line when the task declares none", () => {
    const { expectedOutput: _drop, ...bare } = task
    const prompt = buildLeadReviewPrompt({
      task: bare,
      workerOutput: "done",
      evidence: commitEvidence,
      revision: 0,
    })
    expect(prompt).not.toContain("Expected output:")
  })

  it("survives a revision round with no recorded feedback", () => {
    // Defensive: the loop always passes its own previous feedback, but a
    // verdict with an empty feedback string must not render "undefined".
    const prompt = buildLeadReviewPrompt({
      task,
      workerOutput: "fixed",
      evidence: commitEvidence,
      revision: 1,
    })
    expect(prompt).toContain("(none recorded)")
    expect(prompt).not.toContain("undefined")
  })

  it("renders an evidence block with no diff text without printing undefined", () => {
    const prompt = buildLeadReviewPrompt({
      task,
      workerOutput: "done",
      evidence: { kind: "commit", truncated: false, files: [] },
      revision: 0,
    })
    expect(prompt).not.toContain("undefined")
  })

  it("labels shared-working-dir evidence as uncommitted", () => {
    const prompt = buildLeadReviewPrompt({
      task,
      workerOutput: "done",
      evidence: { ...commitEvidence, kind: "worktree" },
      revision: 0,
    })
    expect(prompt).toMatch(/Uncommitted changes/i)
  })
})
