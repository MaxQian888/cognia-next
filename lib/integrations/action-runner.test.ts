/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { createIntegrationAccount } from "@/lib/db/integrations"
import { registerAuthenticationProvider } from "@/lib/plugin/auth/auth-provider-registry"
import { __resetIntegrationRegistryForTesting, registerIntegrationDefinitions } from "./registry"
import {
  approveIntegrationActionJob,
  authenticatedIntegrationRequest,
  cancelIntegrationActionJob,
  executeIntegrationAction,
  setGithubIssueLoopExecutorForTesting,
  setIntegrationAuthenticatedRequestExecutorForTesting,
} from "./action-runner"

describe("Integration action runner", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    __resetIntegrationRegistryForTesting()
    setIntegrationAuthenticatedRequestExecutorForTesting(async <T>() => ({
      status: 200,
      headers: {},
      data: { ok: true } as T,
    }))
  })

  afterEach(() => {
    setIntegrationAuthenticatedRequestExecutorForTesting()
    setGithubIssueLoopExecutorForTesting()
  })

  async function setup(
    updateHandler: (input: Record<string, unknown>) => Promise<unknown> = async (input) => ({
      updated: input.issueId,
    })
  ) {
    registerIntegrationDefinitions({
      pluginId: "example-delivery",
      definitions: [
        {
          id: "example",
          label: "Example",
          authStrategies: [
            {
              id: "oauth",
              type: "oauth2",
              label: "OAuth",
              providerId: "example-oauth",
            },
          ],
          resourceKinds: ["issue"],
          eventTypes: [],
          actions: [
            {
              id: "issue.read",
              label: "Read issue",
              handler: "readIssue",
              inputSchema: { type: "object" },
              risk: "read",
              idempotency: "supported",
            },
            {
              id: "issue.update",
              label: "Update issue",
              handler: "updateIssue",
              inputSchema: { type: "object" },
              risk: "write",
              idempotency: "required",
            },
            {
              id: "issue.delete",
              label: "Delete issue",
              handler: "deleteIssue",
              inputSchema: { type: "object" },
              risk: "destructive",
              idempotency: "none",
            },
          ],
          allowedOrigins: ["https://api.example.test"],
        },
      ],
      handlers: {
        "example:issue.read": async (_input, context) =>
          context.authenticatedRequest("https://api.example.test/issues/1"),
        "example:issue.update": updateHandler,
        "example:issue.delete": async () => ({ deleted: true }),
      },
    })
    const account = await createIntegrationAccount("example-delivery", {
      integrationId: "example",
      providerId: "example-oauth",
      authSessionId: "opaque",
      remoteAccountId: "acct",
      label: "Example account",
    })
    return account
  }

  it("executes read actions immediately through the host request boundary", async () => {
    const account = await setup()
    const job = await executeIntegrationAction("example-delivery", {
      integrationId: "example",
      accountId: account.id,
      actionId: "issue.read",
      input: {},
    })

    expect(job.status).toBe("succeeded")
    expect(job.output).toEqual({ status: 200, headers: {}, data: { ok: true } })
  })

  it("fails closed before an authenticated request can send PII", async () => {
    await expect(
      authenticatedIntegrationRequest(
        "example-delivery",
        "account-1",
        "https://api.example.test/issues",
        { body: JSON.stringify({ email: "person@example.com" }) }
      )
    ).rejects.toThrow("blocked by the PII gate")
  })

  it("requires host approval before write actions and preserves idempotency", async () => {
    const account = await setup()
    const input = {
      integrationId: "example",
      accountId: account.id,
      actionId: "issue.update",
      input: { issueId: "EX-1" },
      idempotencyKey: "workflow-run-1",
    } as const

    const awaiting = await executeIntegrationAction("example-delivery", input)
    const duplicate = await executeIntegrationAction("example-delivery", input)
    expect(awaiting.status).toBe("awaiting_approval")
    expect(duplicate.id).toBe(awaiting.id)

    const approved = await approveIntegrationActionJob(awaiting.id)
    expect(approved).toMatchObject({
      status: "succeeded",
      output: { updated: "EX-1" },
    })
  })

  it("routes the first-party Issue Loop through the allowlisted host executor", async () => {
    const hostExecutor = jest.fn(async () => ({ pullRequestNumber: 11 }))
    setGithubIssueLoopExecutorForTesting(hostExecutor)
    registerIntegrationDefinitions({
      pluginId: "github-delivery",
      definitions: [
        {
          id: "github",
          label: "GitHub",
          authStrategies: [
            {
              id: "pat",
              type: "personal-access-token",
              label: "PAT",
              providerId: "github-pat",
            },
          ],
          resourceKinds: ["repository"],
          eventTypes: [],
          actions: [
            {
              id: "runIssueLoop",
              label: "Issue Loop",
              handler: "pluginRunIssueLoop",
              inputSchema: { type: "object" },
              risk: "write",
              idempotency: "required",
            },
          ],
        },
      ],
      handlers: {
        "github:runIssueLoop": async () => {
          throw new Error("plugin handler must not receive host privileges")
        },
      },
    })
    const account = await createIntegrationAccount("github-delivery", {
      integrationId: "github",
      providerId: "github-pat",
      authSessionId: "opaque",
      remoteAccountId: "acct",
      label: "GitHub account",
    })
    const awaiting = await executeIntegrationAction("github-delivery", {
      integrationId: "github",
      accountId: account.id,
      actionId: "runIssueLoop",
      input: {},
      idempotencyKey: "issue-loop-1",
    })

    const completed = await approveIntegrationActionJob(awaiting.id)
    expect(completed).toMatchObject({ status: "succeeded", output: { pullRequestNumber: 11 } })
    expect(hostExecutor).toHaveBeenCalledTimes(1)
  })

  it("never bypasses approval for destructive actions and supports cancellation", async () => {
    const account = await setup()
    const awaiting = await executeIntegrationAction("example-delivery", {
      integrationId: "example",
      accountId: account.id,
      actionId: "issue.delete",
      input: { issueId: "EX-1" },
    })

    expect(awaiting.status).toBe("awaiting_approval")
    await expect(cancelIntegrationActionJob(awaiting.id)).resolves.toMatchObject({
      status: "cancelled",
    })
  })

  it("honors retry-after signals for idempotent actions", async () => {
    const account = await setup(async () => {
      throw Object.assign(new Error("rate limited"), {
        retryAfter: "30",
        requestId: "github-request-1",
        status: 429,
        category: "rate_limit",
        rateLimitReset: "1786240000",
      })
    })
    const awaiting = await executeIntegrationAction("example-delivery", {
      integrationId: "example",
      accountId: account.id,
      actionId: "issue.update",
      input: { issueId: "EX-1" },
      idempotencyKey: "retry-1",
    })
    const before = Date.now()
    const retrying = await approveIntegrationActionJob(awaiting.id)
    expect(retrying.status).toBe("retry_wait")
    expect(new Date(retrying.nextAttemptAt!).getTime()).toBeGreaterThanOrEqual(before + 29_000)
    await expect(
      getDb().integrationAudit.where("kind").equals("action.issue.update").first()
    ).resolves.toMatchObject({
      detail: expect.objectContaining({
        requestId: "github-request-1",
        status: 429,
        statusClass: "rate_limit",
        nextRetryAt: retrying.nextAttemptAt,
      }),
    })
  })

  it("injects provider-specific credential headers inside the host boundary", async () => {
    setIntegrationAuthenticatedRequestExecutorForTesting()
    registerIntegrationDefinitions({
      pluginId: "header-delivery",
      definitions: [
        {
          id: "header",
          label: "Header",
          authStrategies: [
            {
              id: "token",
              type: "personal-access-token",
              label: "Token",
              providerId: "header-token",
              requestAuth: { type: "header", name: "private-token", prefix: "token " },
            },
          ],
          resourceKinds: [],
          eventTypes: [],
          actions: [],
          allowedOrigins: ["https://gitlab.example.test"],
        },
      ],
      handlers: {},
    })
    const dispose = registerAuthenticationProvider({
      id: "header-token",
      label: "Header token",
      pluginId: "header-delivery",
      getSessions: async () => [
        {
          id: "opaque-session",
          accessToken: "secret-value",
          account: { id: "remote", label: "Remote" },
          scopes: [],
        },
      ],
      createSession: async () => {
        throw new Error("not used")
      },
      removeSession: async () => undefined,
    })
    const account = await createIntegrationAccount("header-delivery", {
      integrationId: "header",
      providerId: "header-token",
      authSessionId: "opaque-session",
      remoteAccountId: "remote",
      label: "Header account",
    })
    const originalFetch = global.fetch
    const fetchMock = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ ok: true }),
      text: async () => "",
    } as Response)
    global.fetch = fetchMock as unknown as typeof fetch

    try {
      await authenticatedIntegrationRequest(
        "header-delivery",
        account.id,
        "https://gitlab.example.test/api/v4/user",
        { headers: { "Private-Token": "plugin-attempt" } }
      )

      const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers
      expect(headers.get("private-token")).toBe("token secret-value")
      expect(headers.get("authorization")).toBeNull()
    } finally {
      global.fetch = originalFetch
      dispose()
    }
  })

  it("resolves short-lived credentials inside the host request boundary", async () => {
    setIntegrationAuthenticatedRequestExecutorForTesting()
    registerIntegrationDefinitions({
      pluginId: "app-delivery",
      definitions: [
        {
          id: "app",
          label: "App",
          authStrategies: [
            {
              id: "app",
              type: "app",
              label: "App",
              providerId: "dynamic-app",
              requestAuth: { type: "bearer" },
            },
          ],
          resourceKinds: [],
          eventTypes: [],
          actions: [],
          allowedOrigins: ["https://api.example.test"],
        },
      ],
      handlers: {},
    })
    const resolveRequestCredential = jest.fn(async () => ({
      accessToken: "short-lived-token",
      expiresAt: "2026-08-09T12:00:00.000Z",
    }))
    const dispose = registerAuthenticationProvider({
      id: "dynamic-app",
      label: "Dynamic App",
      pluginId: null,
      getSessions: async () => [
        {
          id: "app-session",
          accessToken: "host-owned-placeholder",
          account: { id: "42", label: "Installation 42" },
          scopes: [],
        },
      ],
      createSession: async () => {
        throw new Error("not used")
      },
      removeSession: async () => undefined,
      resolveRequestCredential,
    })
    const account = await createIntegrationAccount("app-delivery", {
      integrationId: "app",
      providerId: "dynamic-app",
      authSessionId: "app-session",
      remoteAccountId: "42",
      label: "Installation 42",
    })
    const originalFetch = global.fetch
    const fetchMock = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ ok: true }),
      text: async () => "",
    } as Response)
    global.fetch = fetchMock as unknown as typeof fetch

    try {
      await authenticatedIntegrationRequest(
        "app-delivery",
        account.id,
        "https://api.example.test/app/installations/42"
      )

      expect(resolveRequestCredential).toHaveBeenCalledWith("app-session", {
        accountId: account.id,
        origin: "https://api.example.test",
      })
      const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers
      expect(headers.get("authorization")).toBe("Bearer short-lived-token")
    } finally {
      global.fetch = originalFetch
      dispose()
    }
  })
})
