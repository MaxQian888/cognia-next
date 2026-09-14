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
import packagedManifest from "../plugin.json"

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
  it("keeps packaged review action schemas identical to builtin exports", () => {
    expect(JSON.parse(JSON.stringify(githubExports.manifest))).toEqual(packagedManifest)
  })
  it("preserves approved review whitespace exactly", async () => {
    const request = jest.fn(async () => ({
      status: 200,
      headers: {},
      data: { id: 1 },
    })) as jest.Mock
    await githubExports.reviewPr(
      { repoFullName: "owner/repo", prNumber: 1, body: "  Exact body\n " },
      { ...providerContext(request), jobId: "job", signal: new AbortController().signal }
    )
    expect(JSON.parse(request.mock.calls[0][1].body).body).toBe("  Exact body\n ")
  })
  it("keeps legacy PR creation and merge transport contracts available outside the Bot allowlist", async () => {
    const request = jest.fn(async () => ({
      status: 200,
      headers: {},
      data: { id: 1 },
    })) as jest.Mock
    const context = {
      ...providerContext(request),
      jobId: "job",
      signal: new AbortController().signal,
    }
    await githubExports.openPr(
      { repoFullName: "owner/repo", title: "Title", head: "feature", base: "main" },
      context
    )
    expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({
      title: "Title",
      head: "feature",
      base: "main",
      draft: false,
    })
    await githubExports.mergePr(
      {
        repoFullName: "owner/repo",
        prNumber: 1,
        mergeMethod: "squash",
        commitTitle: "Title",
        commitMessage: "Body",
      },
      context
    )
    expect(request.mock.calls[1][0]).toContain("/pulls/1/merge")
    expect(JSON.parse(request.mock.calls[1][1].body)).toMatchObject({
      merge_method: "squash",
      commit_title: "Title",
      commit_message: "Body",
    })
    await githubExports.closePr({ repoFullName: "owner/repo", prNumber: 1 }, context)
    expect(JSON.parse(request.mock.calls[2][1].body)).toEqual({ state: "closed" })
    await githubExports.mergePr({ repoFullName: "owner/repo", prNumber: 1 }, context)
    expect(JSON.parse(request.mock.calls[3][1].body)).toEqual({ merge_method: "squash" })
  })

  it("publishes an inline-only review without inventing body content", async () => {
    const sha = "a".repeat(40)
    const request = jest
      .fn()
      .mockResolvedValueOnce({ status: 200, headers: {}, data: { state: "open", head: { sha } } })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: [] })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: { id: 1 } })
    await githubExports.reviewPrInline(
      {
        repoFullName: "owner/repo",
        prNumber: 1,
        commitId: sha,
        comments: [{ path: "file", line: 1, side: "LEFT", body: "Bug" }],
      },
      { ...providerContext(request), jobId: "job", signal: new AbortController().signal }
    )
    expect(JSON.parse(request.mock.calls[2][1].body).body).toBe("")
  })

  it("discovers PAT repositories and scoped health without requiring GitHub App identity", async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce({ status: 403, headers: {}, data: {} })
      .mockResolvedValueOnce({
        status: 200,
        headers: { link: '<https://api.github.com/user/repos?page=1>; rel="prev"' },
        data: [{}, { full_name: "owner/repo" }],
      })
      .mockResolvedValueOnce({ status: 404, headers: {}, data: {} })
      .mockResolvedValueOnce({
        status: 200,
        headers: { "x-oauth-scopes": "repo, read:user" },
        data: { login: "actor" },
      })
    const context = providerContext(request)
    expect(
      await listGithubResources(
        { accountId: "account-1", kind: "repository", cursor: "bad" },
        context
      )
    ).toMatchObject({ items: [{ id: "owner/repo", parent: undefined }] })
    expect(await checkGithubHealth(context)).toMatchObject({
      health: "healthy",
      grantedPermissions: ["repo", "read:user"],
    })
    await expect(
      listGithubResources({ accountId: "account-1", kind: "unknown" }, context)
    ).rejects.toThrow("Unsupported")
  })

  it.each([false, true])(
    "surfaces health HTTP failure with optional provider message %s",
    async (withMessage) => {
      const request = jest.fn(async () => ({
        status: 503,
        headers: {},
        data: withMessage ? { message: "Unavailable" } : {},
      })) as jest.Mock
      await expect(checkGithubHealth(providerContext(request))).rejects.toMatchObject({
        category: "transient",
        status: 503,
      })
    }
  )

  it.each(["installation", "pat"])("surfaces failed %s repository discovery", async (mode) => {
    const request = jest
      .fn()
      .mockResolvedValueOnce({ status: mode === "pat" ? 403 : 500, headers: {}, data: {} })
    if (mode === "pat") request.mockResolvedValueOnce({ status: 401, headers: {}, data: {} })
    request.mockResolvedValueOnce({ status: 401, headers: {}, data: { message: "Expired" } })
    await expect(
      listGithubResources({ accountId: "account-1", kind: "repository" }, providerContext(request))
    ).rejects.toMatchObject({ category: "authentication" })
  })
  it.each([
    [
      "commentPr",
      { prNumber: 1, body: "Review context" },
      "/issues/1/comments",
      "POST",
      { body: "Review context" },
    ],
    [
      "commentIssue",
      { issueNumber: 1, body: "Diagnosis" },
      "/issues/1/comments",
      "POST",
      { body: "Diagnosis" },
    ],
    [
      "labelIssue",
      { issueNumber: 1, labels: ["bug"] },
      "/issues/1/labels",
      "POST",
      { labels: ["bug"] },
    ],
    [
      "closeIssue",
      { issueNumber: 1 },
      "/issues/1",
      "PATCH",
      { state: "closed", state_reason: "completed" },
    ],
    [
      "closeIssue",
      { issueNumber: 1, reason: "not_planned" },
      "/issues/1",
      "PATCH",
      { state: "closed", state_reason: "not_planned" },
    ],
    ["updateIssue", { issueNumber: 1, title: "Title" }, "/issues/1", "PATCH", { title: "Title" }],
    [
      "updateIssue",
      {
        issueNumber: 1,
        body: "Body",
        state: "closed",
        stateReason: "completed",
        labels: [],
        milestone: null,
        assignees: [],
      },
      "/issues/1",
      "PATCH",
      {
        body: "Body",
        state: "closed",
        state_reason: "completed",
        labels: [],
        milestone: null,
        assignees: [],
      },
    ],
    [
      "createRelease",
      { tag: "v1", draft: true, prerelease: true },
      "/releases",
      "POST",
      { tag_name: "v1", draft: true, prerelease: true },
    ],
    [
      "pushTag",
      { tag: "v1", sha: "abc" },
      "/git/refs",
      "POST",
      { ref: "refs/tags/v1", sha: "abc" },
    ],
  ] as const)(
    "preserves the existing %s action contract",
    async (action, input, suffix, method, expected) => {
      const request = jest.fn(async () => ({
        status: 200,
        headers: {},
        data: { id: 1 },
      })) as jest.Mock
      await githubExports[action](
        { repoFullName: "owner/repo", ...input },
        { ...providerContext(request), jobId: "job", signal: new AbortController().signal }
      )
      expect(request.mock.calls[0][0]).toBe(`https://api.github.com/repos/owner/repo${suffix}`)
      expect(request.mock.calls[0][1].method).toBe(method)
      expect(JSON.parse(request.mock.calls[0][1].body)).toEqual(expected)
    }
  )

  it("retains read-only changelog and explicit unavailable Issue Loop behavior", async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        data: {
          commits: [{ sha: "123456789", commit: { message: "Fix\nDetail" } }, { sha: "abcdefghi" }],
        },
      })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: {} })
    const context = {
      ...providerContext(request),
      jobId: "job",
      signal: new AbortController().signal,
    }
    const input = { repoFullName: "owner/repo", base: "base", head: "head" }
    expect(await githubExports.generateChangelog(input, context)).toMatchObject({
      markdown: "- Fix (1234567)\n- abcdefghi (abcdefg)",
    })
    expect(await githubExports.generateChangelog(input, context)).toEqual({
      markdown: "",
      commits: [],
    })
    await expect(githubExports.runIssueLoop({}, context)).rejects.toThrow("unavailable")
    await expect(githubPlugin.activate({} as never)).resolves.toBeUndefined()
  })

  it.each([
    [401, "authentication"],
    [403, "permission"],
    [409, "conflict"],
    [422, "validation"],
    [500, "transient"],
    [404, "permanent"],
    [429, "rate_limit"],
  ] as const)("preserves actionable HTTP %s publication errors", async (status, category) => {
    const request = jest.fn(async () => ({ status, headers: {}, data: null })) as jest.Mock
    await expect(
      githubExports.commentIssue(
        { repoFullName: "owner/repo", issueNumber: 1, body: "Text" },
        { ...providerContext(request), jobId: "job", signal: new AbortController().signal }
      )
    ).rejects.toMatchObject({ category, status })
  })

  it.each([{ prNumber: 0 }, { body: " " }, { repoFullName: "" }])(
    "rejects malformed existing comment input %j",
    async (patch) => {
      const request = jest.fn()
      await expect(
        Promise.resolve().then(() =>
          githubExports.commentPr(
            { repoFullName: "owner/repo", prNumber: 1, body: "Text", ...patch },
            { ...providerContext(request), jobId: "job", signal: new AbortController().signal }
          )
        )
      ).rejects.toThrow("requires")
      expect(request).not.toHaveBeenCalled()
    }
  )
  it.each(["COMMENT", "REQUEST_CHANGES", "APPROVE"])(
    "publishes %s reviews at the exact head",
    async (event) => {
      const sha = "a".repeat(40)
      const comments = [
        { path: "src/file.ts", line: 3, side: "RIGHT", body: "Null input crashes here" },
      ]
      const request = jest.fn(async (url: string, init?: { method?: string }) => ({
        status: 200,
        headers: {},
        data: url.endsWith("/user")
          ? { id: 1 }
          : init?.method === "POST"
            ? { id: 99 }
            : url.includes("/reviews?")
              ? []
              : { state: "open", head: { sha }, user: { id: 2 } },
      })) as jest.Mock
      const context = {
        ...providerContext(request),
        jobId: "job",
        signal: new AbortController().signal,
      }
      await githubExports.reviewPr(
        {
          repoFullName: "owner/repo",
          prNumber: 1,
          body: "Review",
          event,
          commitId: sha,
          ...(event === "APPROVE" ? {} : { comments }),
        },
        context
      )
      const post = request.mock.calls.find((call) => call[1]?.method === "POST")!
      expect(JSON.parse(post[1].body)).toEqual({
        event,
        body: "Review",
        commit_id: sha,
        ...(event === "APPROVE" ? {} : { comments }),
      })
    }
  )

  it.each(["self", "bot", "unknown-viewer", "unknown-author"])(
    "never approves %s PR identity",
    async (kind) => {
      const sha = "a".repeat(40)
      const request = jest.fn(async (url: string) => ({
        status: 200,
        headers: {},
        data: url.endsWith("/user")
          ? kind === "unknown-viewer"
            ? {}
            : { id: 1 }
          : {
              state: "open",
              head: { sha },
              ...(kind === "unknown-author" ? {} : { user: { id: kind === "self" ? 1 : 2 } }),
              ...(kind === "bot" ? { body: "<!-- cognia-github-devin:owned -->" } : {}),
            },
      })) as jest.Mock
      await expect(
        githubExports.reviewPr(
          {
            repoFullName: "owner/repo",
            prNumber: 1,
            body: "Looks good",
            event: "APPROVE",
            commitId: sha,
          },
          { ...providerContext(request), jobId: "job", signal: new AbortController().signal }
        )
      ).rejects.toThrow(/Cannot/)
      expect(request.mock.calls.every((call) => call[1]?.method === "GET")).toBe(true)
    }
  )

  it.each([false, true])(
    "reconciles inline review content exactly (changed: %s)",
    async (changed) => {
      const sha = "a".repeat(40)
      const comments = [{ path: "file", line: 1, side: "RIGHT", body: "Bug" }]
      const request = jest.fn(async (url: string) => ({
        status: 200,
        headers: {},
        data: url.includes("/comments?")
          ? [{ ...comments[0], body: changed ? "Different" : "Bug" }]
          : url.includes("/reviews?")
            ? [{ id: 99, state: "CHANGES_REQUESTED", body: "Review", commit_id: sha }]
            : { state: "open", head: { sha } },
      })) as jest.Mock
      const pending = githubExports.reviewPrInline(
        {
          repoFullName: "owner/repo",
          prNumber: 1,
          body: "Review",
          event: "REQUEST_CHANGES",
          commitId: sha,
          comments,
        },
        { ...providerContext(request), jobId: "job", signal: new AbortController().signal }
      )
      if (changed) await expect(pending).rejects.toThrow("differs")
      else await expect(pending).resolves.toMatchObject({ id: 99 })
      expect(request.mock.calls.every((call) => call[1]?.method === "GET")).toBe(true)
    }
  )

  it.each([
    { event: "MERGE" },
    { event: "APPROVE" },
    { comments: [{ path: "../private", line: 1, side: "RIGHT", body: "Bug" }] },
    { comments: [{ path: "file", line: 0, side: "RIGHT", body: "Bug" }] },
    { comments: [{ path: "file", line: 1, side: "TOP", body: "Bug" }] },
    { comments: [{ path: "file", line: 1, side: "RIGHT", body: "" }] },
    { event: "APPROVE", comments: [{ path: "file", line: 1, side: "RIGHT", body: "Bug" }] },
  ])("rejects invalid review contract %j before writes", async (patch) => {
    const request = jest.fn()
    await expect(
      githubExports.reviewPr(
        { repoFullName: "owner/repo", prNumber: 1, body: "Review", ...patch },
        { ...providerContext(request), jobId: "job", signal: new AbortController().signal }
      )
    ).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })
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
    const existing = { id: 55, body: input.body, commit_id: input.commitId, state: "COMMENTED" }
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
