import type { Octokit } from "@octokit/core"
import type { AdapterContext } from "@/types/connectors/adapter"
import type { OutboundRequest } from "@/types/connectors/outbound"
import { encodeConversationKey } from "./conversation-key"
import { GithubAdapter, createGithubAdapter } from "./github-adapter"

function fakeOctokit(responses: Record<string, unknown>): Octokit {
  return {
    request: jest.fn(async (route: string) => responses[route] ?? { data: {} }),
  } as unknown as Octokit
}

function makeRequest(overrides: Partial<OutboundRequest> = {}): OutboundRequest {
  return {
    conversationRef: {
      platform: "github",
      adapterId: "github-delivery",
      repoFullName: "octo/hello",
      refKind: "issue",
      refNumber: 7,
    },
    segments: [{ type: "text", text: "Hi from cognia" }],
    metadata: { idempotencyKey: "i-1" },
    ...overrides,
  }
}

function fakeContext(): AdapterContext {
  return {
    emit: jest.fn(async () => undefined),
    tauri: {
      httpRequest: jest.fn(),
      openWs: jest.fn(),
      fetchAttachment: jest.fn(),
      bindWebhookRoute: jest.fn(),
      unbindWebhookRoute: jest.fn(),
      publicBaseUrl: jest.fn(async () => null),
    },
    secrets: {
      get: jest.fn(async () => null),
      set: jest.fn(async () => undefined),
      delete: jest.fn(async () => undefined),
      list: jest.fn(async () => []),
    },
    logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    signal: new AbortController().signal,
    adapterId: "github-delivery",
  } as unknown as AdapterContext
}

describe("GithubAdapter", () => {
  it("posts an issue/PR comment via octokit when ConversationReference has typed fields", async () => {
    const octokit = fakeOctokit({
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments": { data: { id: 42 } },
    })
    const adapter = new GithubAdapter("github-delivery", {
      getOctokit: async () => octokit,
      now: () => 1000,
    })
    await adapter.start(fakeContext())
    const result = await adapter.send(makeRequest())
    expect(result.ok).toBe(true)
    expect(result.platformMessageId).toBe("42")
    const reqMock = octokit.request as unknown as jest.Mock
    expect(reqMock).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      { owner: "octo", repo: "hello", issue_number: 7, body: "Hi from cognia" }
    )
    expect(adapter.health().state).toBe("running")
  })

  it("falls back to decoding the conversationKey when the typed fields are absent", async () => {
    const octokit = fakeOctokit({
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments": { data: { id: 5 } },
    })
    const adapter = new GithubAdapter("github-delivery", { getOctokit: async () => octokit })
    await adapter.start(fakeContext())
    const result = await adapter.send({
      conversationRef: {
        platform: "github",
        adapterId: "github-delivery",
      },
      segments: [{ type: "markdown", md: "## hi" }],
      metadata: {
        idempotencyKey: "k-1",
        conversationKey: encodeConversationKey({
          owner: "octo",
          repo: "hello",
          kind: "pr",
          number: 99,
        }),
      } as unknown as OutboundRequest["metadata"],
    })
    expect(result.ok).toBe(true)
    const reqMock = octokit.request as unknown as jest.Mock
    expect(reqMock.mock.calls[0][1]).toMatchObject({
      owner: "octo",
      repo: "hello",
      issue_number: 99,
      body: "## hi",
    })
  })

  it("returns a validation error when neither typed fields nor key resolve", async () => {
    const adapter = new GithubAdapter("github-delivery", {
      getOctokit: async () => fakeOctokit({}),
    })
    await adapter.start(fakeContext())
    const result = await adapter.send({
      conversationRef: { platform: "github", adapterId: "github-delivery" },
      segments: [{ type: "text", text: "x" }],
      metadata: { idempotencyKey: "k" },
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("validation")
    expect(result.error?.retryable).toBe(false)
  })

  it("returns a validation error when the body would be empty", async () => {
    const adapter = new GithubAdapter("github-delivery", {
      getOctokit: async () => fakeOctokit({}),
    })
    await adapter.start(fakeContext())
    const result = await adapter.send(makeRequest({ segments: [{ type: "text", text: "   " }] }))
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("validation")
  })

  it("flags 5xx-style errors as retryable, 4xx-style as non-retryable", async () => {
    const adapter5xx = new GithubAdapter("github-delivery", {
      getOctokit: async () =>
        ({
          request: jest.fn(async () => {
            throw new Error("503 Service Unavailable")
          }),
        }) as unknown as Octokit,
    })
    await adapter5xx.start(fakeContext())
    const r5 = await adapter5xx.send(makeRequest())
    expect(r5.ok).toBe(false)
    expect(r5.error?.code).toBe("platform_5xx")
    expect(r5.error?.retryable).toBe(true)
    expect(adapter5xx.health().state).toBe("degraded")

    const adapter4xx = new GithubAdapter("github-delivery", {
      getOctokit: async () =>
        ({
          request: jest.fn(async () => {
            throw new Error("422 Unprocessable Entity")
          }),
        }) as unknown as Octokit,
    })
    await adapter4xx.start(fakeContext())
    const r4 = await adapter4xx.send(makeRequest())
    expect(r4.error?.code).toBe("platform_4xx")
    expect(r4.error?.retryable).toBe(false)
  })

  it("createGithubAdapter is a factory returning new instances", () => {
    const factory = createGithubAdapter({ getOctokit: async () => fakeOctokit({}) })
    const a = factory("a")
    const b = factory("b")
    expect(a).not.toBe(b)
    expect(a.id).toBe("a")
    expect(b.id).toBe("b")
  })
})
