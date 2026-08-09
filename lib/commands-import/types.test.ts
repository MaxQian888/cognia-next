import { commandNameFromPath, parseCommandMarkdown } from "./types"

describe("command import parsing", () => {
  it("derives nested command names and parses supported frontmatter", () => {
    expect(commandNameFromPath("/root", "/root/git/review.md")).toBe("git/review")
    expect(
      parseCommandMarkdown(
        "opencode",
        "/root/review.md",
        "review",
        "---\ndescription: Review code\nmodel: openai/gpt-5\nagent: plan\n---\nCheck it"
      )
    ).toMatchObject({
      name: "review",
      description: "Review code",
      model: "openai/gpt-5",
      body: "Check it",
      warnings: [expect.stringContaining("agent")],
    })
  })
})
