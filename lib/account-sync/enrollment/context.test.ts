import { createAccountSyncContext } from "./context"

describe("createAccountSyncContext", () => {
  it("binds the API and the vault to the session's space", async () => {
    const fetchImpl = jest.fn(async () =>
      Response.json({ state: "empty", protocolVersion: 1 })
    ) as unknown as typeof fetch
    const context = createAccountSyncContext(
      {
        localAccountId: "local_1",
        issuer: "https://id.test/api/auth",
        userId: "usr_1",
        spaceId: "s".repeat(43),
        syncUrl: "https://sync.test",
        accessToken: async () => "tok",
      },
      { fetchImpl, now: () => 42 }
    )
    expect(context.api.spaceId).toBe("s".repeat(43))
    expect(context.vault.scope).toEqual({ localAccountId: "local_1", spaceId: "s".repeat(43) })
    expect(context.now()).toBe(42)
    await context.api.space()
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://sync.test/v1/space",
      expect.objectContaining({ method: "GET" })
    )
  })
})
