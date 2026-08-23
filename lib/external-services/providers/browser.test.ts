import type { ServiceConnection } from "@/types/external-service"
import { browserInteractionRequiresTakeover, connectBrowserSite } from "./browser"

describe("generic browser site connections", () => {
  it("creates an isolated account-level profile and domain grants without business actions", async () => {
    const putServiceConnection = jest.fn(async (row: ServiceConnection) => row)
    const connection = await connectBrowserSite(
      {
        name: "Example Admin",
        domains: ["example.com", "https://example.com/path"],
        runtimeTargetId: "local",
        loginStartUrl: "https://example.com/login",
        allowUploads: true,
      },
      {
        createBrowserProfile: jest.fn(async (workspaceId, name) => ({
          id: "profile-1",
          workspaceId,
          name,
          createdAt: 1,
          updatedAt: 1,
        })),
        grantBrowserDomain: jest.fn(async (workspaceId, domain) => ({
          id: `${workspaceId}:${domain}`,
          workspaceId,
          domain,
          createdAt: 1,
          updatedAt: 1,
        })),
        putServiceConnection,
      }
    )

    expect(connection).toMatchObject({
      status: "needs-auth",
      providerRef: {
        kind: "browser",
        profileId: "profile-1",
        allowedDomains: ["example.com"],
        allowUploads: true,
      },
    })
    expect(connection.providerRef.kind === "browser" && connection.providerRef.workspaceId).toBe(
      `external-service:${connection.id}`
    )
    expect(putServiceConnection).toHaveBeenCalledWith(connection)
  })

  it("rejects a login URL outside the reviewed domain set", async () => {
    await expect(
      connectBrowserSite(
        {
          name: "Example",
          domains: ["example.com"],
          runtimeTargetId: "local",
          loginStartUrl: "https://evil.test/login",
        },
        {
          createBrowserProfile: jest.fn(),
          grantBrowserDomain: jest.fn(),
          putServiceConnection: jest.fn(),
        }
      )
    ).rejects.toThrow(/approved domain/)
  })

  it.each(["password", "one-time-code", "captcha", "payment card", "cvv"])(
    "requires human takeover for %s fields",
    (value) => {
      expect(browserInteractionRequiresTakeover({ autocomplete: value })).toBe(true)
    }
  )

  it("allows an ordinary search field to remain agent-operated", () => {
    expect(browserInteractionRequiresTakeover({ fieldName: "query", inputType: "search" })).toBe(
      false
    )
  })
})
