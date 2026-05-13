import { buildIssueSystemPrompt, buildIssueUserPrompt, extractSummary } from "./system-prompt"

describe("buildIssueSystemPrompt", () => {
  it("mentions the SUMMARY tag and the no-push constraint", () => {
    const out = buildIssueSystemPrompt()
    expect(out).toMatch(/<SUMMARY>…<\/SUMMARY>/)
    expect(out).toMatch(/Never `git push`/)
    expect(out).toMatch(/Stay inside the workspace/)
  })
})

describe("buildIssueUserPrompt", () => {
  it("includes repo, issue number, title and body", () => {
    const out = buildIssueUserPrompt({
      repoFullName: "octocat/hello-world",
      issueNumber: 42,
      issueTitle: "Fix the README",
      issueBody: "The contributing section is wrong.",
    })
    expect(out).toMatch(/octocat\/hello-world/)
    expect(out).toMatch(/#42/)
    expect(out).toMatch(/Fix the README/)
    expect(out).toMatch(/contributing section is wrong/)
  })

  it("falls back to a placeholder when the issue body is empty", () => {
    const out = buildIssueUserPrompt({
      repoFullName: "octocat/hello-world",
      issueNumber: 1,
      issueTitle: "Empty body",
      issueBody: "",
    })
    expect(out).toMatch(/no body — read the title/)
  })
})

describe("extractSummary", () => {
  it("returns the inner text of a single SUMMARY block", () => {
    expect(extractSummary("intro\n<SUMMARY>fix the readme typo</SUMMARY>")).toBe(
      "fix the readme typo"
    )
  })

  it("returns the last block when multiple are present", () => {
    expect(extractSummary("<SUMMARY>draft</SUMMARY>\nlater\n<SUMMARY>final</SUMMARY>")).toBe(
      "final"
    )
  })

  it("returns the input trimmed when no SUMMARY tag is present", () => {
    expect(extractSummary("   no tag here   ")).toBe("no tag here")
  })

  it("handles multi-line bodies", () => {
    const out = extractSummary("preamble\n<SUMMARY>\nfirst line\nsecond line\n</SUMMARY>\ntrailing")
    expect(out).toBe("first line\nsecond line")
  })
})
