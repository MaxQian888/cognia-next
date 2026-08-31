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

  it("refuses a collab command it has no route for instead of reporting it written", async () => {
    const refresh = jest.fn().mockResolvedValue(undefined)

    // `liveDispatcher` picks this dispatcher by the `collab_` prefix and calls
    // it through `as never`, so a name that never got a case still arrives.
    // Returning undefined for one made the drain mark the row sent with
    // nothing written to the collaboration server, which loses the edit
    // silently; the throw puts it on the retry-then-deadletter path instead.
    await expect(
      dispatchCollabOutbound(
        "collab_issue_unlisted" as never,
        { orgId: "org-1" },
        {
          localAccountId: "account-1",
          client: {} as never,
          refresh,
        }
      )
    ).rejects.toThrow(/has no dispatch route/i)
    expect(refresh).not.toHaveBeenCalled()
  })
})
