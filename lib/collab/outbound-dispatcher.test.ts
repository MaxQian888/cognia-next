const mockLoadConnection = jest.fn()
const mockReadActiveAccessToken = jest.fn()
const mockPlatformFetch = jest.fn()
jest.mock("@/lib/accounts/active-account-id", () => ({ getActiveAccountId: () => "account-1" }))
jest.mock("./connection", () => ({
  loadCollabConnection: (...args: unknown[]) => mockLoadConnection(...args),
}))
jest.mock("@/lib/logto/app-session", () => ({
  readActiveAccessToken: (...args: unknown[]) => mockReadActiveAccessToken(...args),
}))
jest.mock("@/lib/network/platform-fetch", () => ({
  createPlatformFetch:
    () =>
    (...args: unknown[]) =>
      mockPlatformFetch(...args),
}))

import { dispatchCollabOutbound } from "./outbound-dispatcher"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

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

describe("the default client", () => {
  it("is built on the stored connection and reads a token that is good now", async () => {
    mockLoadConnection.mockReturnValue({ baseUrl: "https://collab.test" })
    mockReadActiveAccessToken.mockResolvedValue("fresh-token")
    mockPlatformFetch.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/grants")) {
        return jsonResponse({
          grant: "g",
          userId: "usr_a",
          orgId: "org-1",
          expiresAt: Math.floor(Date.now() / 1000) + 300,
        })
      }
      return jsonResponse({ id: "iss-1", revision: 2 })
    })
    const refresh = jest.fn().mockResolvedValue(undefined)

    const result = await dispatchCollabOutbound(
      "collab_issue_patch",
      { orgId: "org-1", issueId: "iss-1", operationId: "op-1", baseRevision: 1, title: "T" },
      { refresh }
    )

    expect(result).toEqual({ id: "iss-1", revision: 2 })
    expect(mockLoadConnection).toHaveBeenCalledWith("account-1")
    expect(mockReadActiveAccessToken).toHaveBeenCalledWith("account-1")
    const grantCall = mockPlatformFetch.mock.calls.find((call) =>
      String(call[0]).endsWith("/grants")
    )
    expect((grantCall![1] as RequestInit).headers).toMatchObject({
      authorization: "Bearer fresh-token",
    })
  })

  it("refuses when no server is configured and no client was injected", async () => {
    mockLoadConnection.mockReturnValue(null)
    await expect(
      dispatchCollabOutbound("collab_issue_patch", { orgId: "org-1", issueId: "iss-1" }, {})
    ).rejects.toThrow(/not configured/i)
  })
})
