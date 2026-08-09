import type {
  IntegrationActionHandlerContext,
  IntegrationProviderContext,
  IntegrationVerifiedDelivery,
} from "@/types/plugin/plugin-integration"
import githubPlugin, {
  GithubIntegrationError,
  checkGithubHealth,
  githubIntegration,
  listGithubResources,
  normalizeGithub,
} from "./index"
import * as githubExports from "./index"

function providerContext(
  request: IntegrationProviderContext["authenticatedRequest"]
): IntegrationProviderContext {
  return {
    pluginId: "github-delivery",
    integrationId: "github",
    accountId: "account-1",
    authenticatedRequest: request,
  }
}

describe("GitHub Delivery v3 official plugin", () => {
  it("publishes complete action schemas and host-owned providers", () => {
    expect(githubPlugin.manifest.version).toBe("3.0.0")
    expect(githubIntegration.authStrategies.map((strategy) => strategy.id)).toEqual([
      "github-app",
      "pat",
    ])
    expect(githubIntegration.resourceProvider).toEqual({
      handler: "listGithubResources",
      kinds: ["repository"],
    })
    expect(githubIntegration.healthProvider).toEqual({ handler: "checkGithubHealth" })
    expect(githubIntegration.actions).toHaveLength(13)

    const schemas = Object.fromEntries(
      githubIntegration.actions.map((action) => [action.id, action.inputSchema])
    )
    expect(schemas.mergePr.properties).toMatchObject({
      mergeMethod: { enum: ["merge", "squash", "rebase"] },
      commitTitle: { type: "string" },
      commitMessage: { type: "string" },
    })
    expect(schemas.reviewPr.properties).toHaveProperty("event")
    expect(schemas.reviewPrInline.properties).toMatchObject({
      body: { type: "string" },
      event: expect.any(Object),
    })
    expect(schemas.closeIssue.properties).toHaveProperty("reason")
    expect(schemas.createRelease.properties).toMatchObject({
      name: { type: "string" },
      body: { type: "string" },
      target: { type: "string" },
      draft: { type: "boolean" },
      prerelease: { type: "boolean" },
    })
  })

  it("paginates repository discovery and preserves quota state", async () => {
    const authenticatedRequest = jest.fn(async () => ({
      status: 200,
      headers: {
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "4999",
        "x-ratelimit-reset": "1786258800",
        link: '<https://api.github.com/installation/repositories?page=3>; rel="next"',
      },
      data: {
        repositories: [
          {
            full_name: "cognia/cognia-next",
            html_url: "https://github.com/cognia/cognia-next",
            owner: { login: "cognia" },
          },
        ],
      },
    })) as unknown as IntegrationProviderContext["authenticatedRequest"]

    await expect(
      listGithubResources(
        { accountId: "account-1", kind: "repository", query: "cognia", cursor: "2", limit: 25 },
        providerContext(authenticatedRequest)
      )
    ).resolves.toMatchObject({
      items: [
        {
          kind: "repository",
          id: "cognia/cognia-next",
          name: "cognia/cognia-next",
          parent: { kind: "installation", id: "cognia" },
        },
      ],
      nextCursor: "3",
      rateLimit: { limit: 5000, remaining: 4999 },
    })
  })

  it("returns permission-aware App health and classifies API failures", async () => {
    const healthy = providerContext(
      jest.fn(async () => ({
        status: 200,
        headers: {
          "x-ratelimit-remaining": "4998",
          "x-ratelimit-reset": "1786258800",
        },
        data: {
          suspended_at: null,
          permissions: {
            checks: "read",
            contents: "write",
            issues: "write",
            metadata: "read",
            pull_requests: "write",
          },
        },
      })) as unknown as IntegrationProviderContext["authenticatedRequest"]
    )
    await expect(checkGithubHealth(healthy)).resolves.toMatchObject({
      health: "healthy",
      grantedPermissions: [
        "checks:read",
        "contents:write",
        "issues:write",
        "metadata:read",
        "pull_requests:write",
      ],
    })

    const limited = providerContext(
      jest.fn(async () => ({
        status: 429,
        headers: {
          "x-github-request-id": "request-rate",
          "retry-after": "60",
        },
        data: { message: "secondary rate limit" },
      })) as unknown as IntegrationProviderContext["authenticatedRequest"]
    )
    await expect(checkGithubHealth(limited)).rejects.toMatchObject({
      name: "GithubIntegrationError",
      category: "rate_limit",
      status: 429,
      requestId: "request-rate",
      retryAfter: "60",
    } satisfies Partial<GithubIntegrationError>)
  })

  it("normalizes installation lifecycle events without inventing subscriptions", () => {
    const delivery: IntegrationVerifiedDelivery = {
      routeId: "route-1",
      deliveryId: "delivery-1",
      eventType: "installation",
      headers: {},
      body: JSON.stringify({
        action: "suspend",
        installation: { id: 42, account: { login: "cognia" } },
      }),
      receivedAt: "2026-08-09T00:00:00.000Z",
    }
    expect(
      normalizeGithub(delivery, {
        pluginId: "github-delivery",
        integrationId: "github",
        accountId: "account-1",
      })
    ).toMatchObject({
      eventType: "installation.suspend",
      deliveryId: "delivery-1",
      resource: { kind: "installation", id: "42", name: "cognia" },
    })
  })

  it("keeps every declared action and event wired to a runtime export", () => {
    for (const action of githubIntegration.actions) {
      expect(typeof githubExports[action.handler as keyof typeof githubExports]).toBe("function")
      expect(action.inputSchema).toMatchObject({ type: "object", additionalProperties: false })
    }
    for (const declared of githubIntegration.eventTypes) {
      const separator = declared.id.lastIndexOf(".")
      const eventType = declared.id.slice(0, separator)
      const action = declared.id.slice(separator + 1)
      const normalized = normalizeGithub(
        {
          routeId: "route",
          deliveryId: `delivery-${declared.id}`,
          eventType,
          headers: {},
          body: JSON.stringify({ action }),
          receivedAt: "2026-08-09T00:00:00.000Z",
        },
        {
          pluginId: "github-delivery",
          integrationId: "github",
          accountId: "account",
        }
      )
      expect(normalized.eventType).toBe(declared.id)
    }
  })
})

void ({} as IntegrationActionHandlerContext)
