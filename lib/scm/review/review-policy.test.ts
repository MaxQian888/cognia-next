import {
  DEFAULT_REVIEW_POLICY,
  REVIEW_POLICY_LIMITS,
  defaultReviewPolicy,
  parseReviewPolicyValue,
  parseWorkspaceReviewPolicy,
  readReviewPolicyAtRef,
} from "./review-policy"

describe("parseReviewPolicyValue", () => {
  it("yields the defaults when the block is absent", () => {
    expect(parseReviewPolicyValue(undefined)).toEqual({
      ok: true,
      policy: { ...DEFAULT_REVIEW_POLICY },
    })
  })

  it("returns a fresh copy of the defaults each time", () => {
    const a = defaultReviewPolicy()
    a.protectedPaths.push("x/**")
    expect(defaultReviewPolicy().protectedPaths).toEqual([])
  })

  it("normalizes a full policy and drops duplicate entries", () => {
    const result = parseReviewPolicyValue({
      protectedPaths: ["db/schema/**", " billing/** ", "db/schema/**"],
      requiredChecks: ["unit", "lint", "unit"],
      humanApproval: "always",
      reviewAgent: "optional",
      largeChangeLines: 800,
    })
    expect(result).toEqual({
      ok: true,
      policy: {
        protectedPaths: ["db/schema/**", "billing/**"],
        requiredChecks: ["unit", "lint"],
        humanApproval: "always",
        reviewAgent: "optional",
        largeChangeLines: 800,
      },
    })
  })

  it("refuses a non-object block", () => {
    expect(parseReviewPolicyValue([])).toEqual({
      ok: false,
      problems: [expect.objectContaining({ code: "review_policy_not_object", pointer: "/review" })],
    })
  })

  it("reports every problem at once, each with its pointer", () => {
    const result = parseReviewPolicyValue({
      protectedPaths: ["../outside/**", "/abs/**", "C:/win", "a\\b", "ok/**"],
      requiredChecks: ["-bad"],
      humanApproval: "never",
      reviewAgent: "sometimes",
      largeChangeLines: 0,
      surprise: true,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    const pointers = result.problems.map((problem) => `${problem.code}@${problem.pointer}`)
    expect(pointers).toEqual(
      expect.arrayContaining([
        "review_policy_field_unknown@/review/surprise",
        "review_policy_paths_invalid@/review/protectedPaths/0",
        "review_policy_paths_invalid@/review/protectedPaths/1",
        "review_policy_paths_invalid@/review/protectedPaths/2",
        "review_policy_paths_invalid@/review/protectedPaths/3",
        "review_policy_checks_invalid@/review/requiredChecks/0",
        "review_policy_human_approval_invalid@/review/humanApproval",
        "review_policy_review_agent_invalid@/review/reviewAgent",
        "review_policy_large_change_invalid@/review/largeChangeLines",
      ])
    )
    expect(pointers).not.toContain("review_policy_paths_invalid@/review/protectedPaths/4")
  })

  it("has no humanApproval value that relaxes the built-in gate", () => {
    expect(parseReviewPolicyValue({ humanApproval: "never" }).ok).toBe(false)
  })

  it("enforces list limits", () => {
    const tooMany = Array.from(
      { length: REVIEW_POLICY_LIMITS.maxProtectedPaths + 1 },
      (_, i) => `p${i}/**`
    )
    const result = parseReviewPolicyValue({ protectedPaths: tooMany })
    expect(result).toEqual({
      ok: false,
      problems: [
        expect.objectContaining({
          code: "review_policy_paths_invalid",
          pointer: "/review/protectedPaths",
        }),
      ],
    })
    expect(parseReviewPolicyValue({ requiredChecks: "unit" }).ok).toBe(false)
  })
})

describe("parseWorkspaceReviewPolicy", () => {
  it("reports a file without a review block as undeclared defaults", () => {
    expect(parseWorkspaceReviewPolicy(JSON.stringify({ version: 1 }))).toEqual({
      ok: true,
      policy: defaultReviewPolicy(),
      declared: false,
    })
  })

  it("reads a declared block", () => {
    const source = JSON.stringify({ version: 1, review: { requiredChecks: ["unit"] } })
    expect(parseWorkspaceReviewPolicy(source)).toEqual({
      ok: true,
      policy: { ...defaultReviewPolicy(), requiredChecks: ["unit"] },
      declared: true,
    })
  })

  it("refuses invalid JSON and comments", () => {
    expect(parseWorkspaceReviewPolicy("{ // no\n }")).toEqual({
      ok: false,
      problems: [expect.objectContaining({ code: "review_policy_document_invalid", pointer: "" })],
    })
  })

  it("refuses a duplicated review key, which JSON.parse would resolve silently", () => {
    const source = '{"review": {"humanApproval": "always"}, "review": {}}'
    expect(parseWorkspaceReviewPolicy(source)).toEqual({
      ok: false,
      problems: [
        expect.objectContaining({ code: "review_policy_key_duplicate", pointer: "/review" }),
      ],
    })
  })

  it("refuses duplicate keys inside the block", () => {
    const source = '{"review": {"humanApproval": "always", "humanApproval": "protected"}}'
    expect(parseWorkspaceReviewPolicy(source)).toEqual({
      ok: false,
      problems: [
        expect.objectContaining({
          code: "review_policy_key_duplicate",
          pointer: "/review/humanApproval",
        }),
      ],
    })
  })
})

describe("readReviewPolicyAtRef", () => {
  it("reads the file at the given ref, not the working tree", async () => {
    const readBlob = jest.fn(async () =>
      JSON.stringify({ review: { protectedPaths: ["billing/**"] } })
    )
    const result = await readReviewPolicyAtRef("/repo", "refs/heads/main", readBlob)
    expect(readBlob).toHaveBeenCalledWith("/repo", "refs/heads/main", ".cognia/workspace.json")
    expect(result).toEqual({
      ok: true,
      policy: { ...defaultReviewPolicy(), protectedPaths: ["billing/**"] },
      declared: true,
    })
  })

  it("treats a missing file as the undeclared defaults", async () => {
    await expect(readReviewPolicyAtRef("/repo", "main", async () => null)).resolves.toEqual({
      ok: true,
      policy: defaultReviewPolicy(),
      declared: false,
    })
  })

  it("refuses an invalid block rather than falling back to defaults", async () => {
    const result = await readReviewPolicyAtRef("/repo", "main", async () => '{"review": 3}')
    expect(result.ok).toBe(false)
  })

  it("refuses an oversized file", async () => {
    const huge = `{"pad": "${"x".repeat(300 * 1024)}"}`
    const result = await readReviewPolicyAtRef("/repo", "main", async () => huge)
    expect(result).toEqual({
      ok: false,
      problems: [expect.objectContaining({ code: "review_policy_document_invalid" })],
    })
  })
})
