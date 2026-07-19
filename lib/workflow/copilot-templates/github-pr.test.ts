import { githubPrCopilotTemplate } from "./github-pr"

describe("githubPrCopilotTemplate", () => {
  it("uses the GitHub delivery plugin's head parameter for the generated branch", () => {
    const workflow = githubPrCopilotTemplate.build({ repoFullName: "owner/repo" })
    const openPr = workflow.nodes.find((node) => node.id === "n_open_pr")

    expect(openPr?.data.params.head).toBe("auto-fix/{{ $trigger.payload.body.issue.number }}")
    expect(openPr?.data.params).not.toHaveProperty("branch")
  })
})
