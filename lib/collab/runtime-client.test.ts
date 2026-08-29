const mockConnections = jest.fn()

jest.mock("@/lib/accounts/active-account-id", () => ({ getActiveAccountId: () => "account_1" }))
jest.mock("./connection", () => ({
  loadCollabConnection: (...args: unknown[]) => mockConnections(...args),
}))
jest.mock("@/lib/network/platform-fetch", () => ({ createPlatformFetch: () => jest.fn() }))

import { resolveCurrentCollabContext } from "./runtime-client"

describe("resolveCurrentCollabContext", () => {
  beforeEach(() => {
    mockConnections.mockReset()
  })

  it("stays disabled when no server is configured", async () => {
    mockConnections.mockReturnValue(null)
    expect(await resolveCurrentCollabContext()).toBeNull()
  })

  it("binds the client to the signed-in person and org", async () => {
    mockConnections.mockReturnValue({ baseUrl: "https://collab.test" })
    const context = await resolveCurrentCollabContext({
      registry: {
        get: jest.fn().mockResolvedValue({ userId: "user_1", orgId: "org_1" }),
      },
      accessToken: async () => "token",
    })
    expect(context).toMatchObject({
      localAccountId: "account_1",
      orgId: "org_1",
      userId: "user_1",
    })
  })

  it("uses the build-gated E2E collaboration context without persisting credentials", async () => {
    const context = await resolveCurrentCollabContext({
      e2eContext: {
        orgId: "org_e2e",
        userId: "usr_e2e",
        baseUrl: "https://collab-e2e.test",
        accessToken: "ephemeral-test-token",
      },
      fetchImpl: jest.fn(),
    })

    expect(context).toMatchObject({
      localAccountId: "account_1",
      orgId: "org_e2e",
      userId: "usr_e2e",
    })
    expect(mockConnections).not.toHaveBeenCalled()
  })
})
