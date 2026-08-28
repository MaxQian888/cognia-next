import { dispatchCollabOutbound } from "./outbound-dispatcher"

describe("dispatchCollabOutbound", () => {
  it("removes routing fields and refreshes after a successful mutation", async () => {
    const patchIssue = jest.fn().mockResolvedValue({ id: "iss-1", revision: 2 })
    const refresh = jest.fn().mockResolvedValue(undefined)

    const result = await dispatchCollabOutbound(
      "collab_issue_patch",
      {
        orgId: "org-1",
        issueId: "iss-1",
        operationId: "op-1",
        baseRevision: 1,
        title: "Changed",
      },
      { localAccountId: "account-1", client: { patchIssue } as never, refresh }
    )

    expect(patchIssue).toHaveBeenCalledWith("org-1", "iss-1", {
      operationId: "op-1",
      baseRevision: 1,
      title: "Changed",
    })
    expect(refresh).toHaveBeenCalledWith("account-1")
    expect(result).toEqual({ id: "iss-1", revision: 2 })
  })
})
