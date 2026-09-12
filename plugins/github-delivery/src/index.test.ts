import type {
  IntegrationActionHandlerContext,
  IntegrationProviderContext,
  IntegrationVerifiedDelivery,
} from "@cognia/plugin-sdk"
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
    expect(githubPlugin.manifest.engines).toEqual({ cognia: ">=0.1.0" })
    expect(githubIntegration.authStrategies.map((strategy) => strategy.id)).toEqual([
      "github-app",
      "pat",
    ])
    expect(githubIntegration.resourceProvider).toEqual({
      handler: "listGithubResources",
      kinds: ["repository"],
    })
    expect(githubIntegration.healthProvider).toEqual({ handler: "checkGithubHealth" })
    expect(githubIntegration.actions).toHaveLength(14)
    expect(
      githubIntegration.actions.every((action) => action.operationId === `github.${action.id}`)
    ).toBe(true)
    expect(githubPlugin.manifest.services?.[0]).toMatchObject({
      id: "github",
      fallbackPolicy: "confirm",
      providers: [
        expect.objectContaining({ id: "api", kind: "integration" }),
        expect.objectContaining({ id: "web", kind: "browser" }),
      ],
    })
    expect(githubPlugin.manifest.browserSiteProviders?.[0].operations).toHaveLength(14)
    expect(githubPlugin.manifest.activationEvents).toBeUndefined()
    expect(githubPlugin.manifest.runtimeCompatibility).toMatchObject({
      tauri: { availability: "supported" },
      browser: { availability: "degraded" },
      mobile: { availability: "degraded" },
      headless: { availability: "degraded" },
    })

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
            actions: "read",
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
        "actions:read",
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

describe("GitHub monitoring events and revision-bound reviews", () => {
  it("declares PR lifecycle, CI completions and sender identity", () => {
    const types = githubIntegration.eventTypes.map((event) => event.id)
    expect(types).toEqual(
      expect.arrayContaining([
        "pull_request.ready_for_review",
        "pull_request.converted_to_draft",
        "issues.reopened",
        "workflow_run.completed",
        "workflow_job.completed",
        "check_suite.completed",
      ])
    )
    const event = normalizeGithub(
      {
        routeId: "route",
        deliveryId: "d",
        eventType: "workflow_run",
        headers: {},
        receivedAt: "2026-09-12T00:00:00Z",
        body: JSON.stringify({
          action: "completed",
          repository: { full_name: "owner/repo" },
          sender: { id: 12, login: "bot[bot]" },
          workflow_run: { head_sha: "a".repeat(40), conclusion: "failure" },
        }),
      },
      { pluginId: "github-delivery", integrationId: "github", accountId: "account" }
    )
    expect(event).toMatchObject({
      eventType: "workflow_run.completed",
      resource: { id: "owner/repo" },
      actor: { id: "12", label: "bot[bot]" },
      payload: { workflow_run: { conclusion: "failure" } },
    })
  })

  it("pins a review to the approved commit instead of a later PR head", async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        data: { state: "open", head: { sha: "a".repeat(40) } },
      })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: [] })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: { id: 1 } })
    await githubExports.reviewPr(
      {
        repoFullName: "owner/repo",
        prNumber: 1,
        body: "Review",
        event: "COMMENT",
        commitId: "a".repeat(40),
      },
      { ...providerContext(request), jobId: "job", signal: new AbortController().signal }
    )
    expect(JSON.parse(request.mock.calls[2][1].body)).toMatchObject({
      commit_id: "a".repeat(40),
      body: "Review",
      event: "COMMENT",
    })
  })
  it("recovers a matching PR after uncertain publication and rejects a moved base", async () => {
    const input = {
      repoFullName: "owner/repo",
      title: "Fix",
      head: "bot/fix",
      base: "main",
      body: "Result",
      expectedBaseSha: "a".repeat(40),
    }
    const existing = { number: 4, title: "Fix", body: "Result", base: { ref: "main" } }
    const request = jest
      .fn()
      .mockResolvedValueOnce({ status: 200, headers: {}, data: { sha: input.expectedBaseSha } })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: [existing] })
    const context = {
      ...providerContext(request),
      jobId: "job",
      signal: new AbortController().signal,
    }
    await expect(githubExports.openPr(input, context)).resolves.toEqual(existing)
    expect(request.mock.calls.every((call) => call[1].method === "GET")).toBe(true)
    request.mockResolvedValueOnce({ status: 200, headers: {}, data: { sha: "b".repeat(40) } })
    await expect(githubExports.openPr(input, context)).rejects.toThrow("SHA changed")
    request
      .mockResolvedValueOnce({ status: 200, headers: {}, data: { sha: input.expectedBaseSha } })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        data: [{ ...existing, body: "Different" }],
      })
    await expect(githubExports.openPr(input, context)).rejects.toThrow("does not match")
  })

  it("creates one PR only when the approved branch has no previous publication", async () => {
    const input = {
      repoFullName: "owner/repo",
      title: "Fix",
      head: "bot/fix",
      base: "main",
      expectedBaseSha: "a".repeat(40),
    }
    const request = jest
      .fn()
      .mockResolvedValueOnce({ status: 200, headers: {}, data: { sha: input.expectedBaseSha } })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: [] })
      .mockResolvedValueOnce({ status: 201, headers: {}, data: { number: 5 } })
    await expect(
      githubExports.openPr(input, {
        ...providerContext(request),
        jobId: "job",
        signal: new AbortController().signal,
      })
    ).resolves.toEqual({ number: 5 })
    expect(request.mock.calls[2][1].method).toBe("POST")
  })

  it("blocks changed published heads before POST and before accepting a reconciled PR", async () => {
    const input = {
      repoFullName: "owner/repo",
      title: "Fix",
      head: "bot/fix",
      base: "main",
      expectedBaseSha: "a".repeat(40),
      expectedHeadSha: "b".repeat(40),
    }
    const existing = {
      number: 4,
      title: "Fix",
      base: { ref: "main" },
      head: { sha: input.expectedHeadSha },
    }
    for (const previous of [[], [existing]]) {
      const request = jest
        .fn()
        .mockResolvedValueOnce({ status: 200, headers: {}, data: { sha: input.expectedBaseSha } })
        .mockResolvedValueOnce({ status: 200, headers: {}, data: previous })
        .mockResolvedValueOnce({ status: 200, headers: {}, data: { sha: "c".repeat(40) } })
      await expect(
        githubExports.openPr(input, {
          ...providerContext(request),
          jobId: "job",
          signal: new AbortController().signal,
        })
      ).rejects.toThrow("head SHA changed")
      expect(request.mock.calls.every((call) => call[1].method === "GET")).toBe(true)
    }
    const request = jest
      .fn()
      .mockResolvedValueOnce({ status: 200, headers: {}, data: { sha: input.expectedBaseSha } })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        data: [{ ...existing, head: { sha: "c".repeat(40) } }],
      })
    await expect(
      githubExports.openPr(input, {
        ...providerContext(request),
        jobId: "job",
        signal: new AbortController().signal,
      })
    ).rejects.toThrow("head does not match")
    expect(request).toHaveBeenCalledTimes(2)
  })

  it("searches paginated reviews before retrying and refuses a stale review head", async () => {
    const input = {
      repoFullName: "owner/repo",
      prNumber: 1,
      body: "Stable review",
      commitId: "a".repeat(40),
    }
    const existing = { id: 55, body: input.body, commit_id: input.commitId }
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        data: { state: "open", head: { sha: input.commitId } },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        data: Array.from({ length: 100 }, () => ({ body: "Other" })),
      })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: [existing] })
    const context = {
      ...providerContext(request),
      jobId: "job",
      signal: new AbortController().signal,
    }
    await expect(githubExports.reviewPr(input, context)).resolves.toEqual(existing)
    expect(request.mock.calls[2][0]).toContain("page=2")
    expect(request.mock.calls.every((call) => call[1].method === "GET")).toBe(true)
    request.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: { state: "open", head: { sha: "b".repeat(40) } },
    })
    await expect(githubExports.reviewPr(input, context)).rejects.toThrow("SHA changed")
  })
})
