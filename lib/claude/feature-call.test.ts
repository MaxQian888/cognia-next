import {
  createSidecarFeatureCallClient,
  discoverMcpServerViaSidecar,
  validateOpenCodeV2Discovery,
} from "./feature-call"
import type { ClaudeEvent, McpServer } from "@cognia/agent-config-types"

describe("sidecar feature-call LanguageModelV3 proxy", () => {
  it("forwards a protocol adapter spec for a diagnostic-compatible custom provider", async () => {
    const calls: Array<Record<string, unknown> | undefined> = []
    const client = createSidecarFeatureCallClient({
      randomUUID: () => "custom-stream",
      subscribe: async () => () => undefined,
      call: async (_command, args) => {
        calls.push(args)
      },
    })
    const spec = {
      kind: "openai-compatible-variant" as const,
      urlTemplate: "{baseURL}/chat/completions",
      responsePaths: { textDelta: "choices.0.delta.content" },
    }
    const model = client.languageModel({
      modelId: "custom-model",
      providerId: "custom-provider",
      credentials: { protocol: "plugin:custom", baseURL: "https://gateway.example/v1" },
      protocolAdapterSpec: spec,
    })

    await model.doStream({ prompt: [] } as never)

    expect(calls[0]).toEqual({
      request: expect.objectContaining({
        requestId: "custom-stream",
        protocolAdapterSpec: spec,
      }),
    })
  })

  it("correlates generate results while sending only default-chain selection metadata", async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = []
    let listener: ((event: ClaudeEvent) => void) | undefined
    const client = createSidecarFeatureCallClient({
      randomUUID: () => "request-1",
      subscribe: async (_event, handler) => {
        listener = handler
        return () => undefined
      },
      call: async (command, args) => {
        calls.push([command, args])
        queueMicrotask(() =>
          listener?.({
            type: "feature_call_result",
            requestId: "request-1",
            result: {
              content: [{ type: "text", text: "hello" }],
              finishReason: "stop",
              usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
              warnings: [],
            },
          })
        )
      },
    })
    const model = client.languageModel({
      modelId: "us.amazon.nova-lite-v1:0",
      credentials: {
        protocol: "bedrock",
        bedrockAuthMode: "default-chain",
        region: "us-east-1",
        profile: "engineering",
      },
    })

    const result = await model.doGenerate({ prompt: [] } as never)
    expect(result.content).toEqual([{ type: "text", text: "hello" }])
    expect(calls[0]).toEqual([
      "claude_feature_call",
      {
        request: expect.objectContaining({
          requestId: "request-1",
          operation: "language-generate",
          credentials: {
            protocol: "bedrock",
            bedrockAuthMode: "default-chain",
            region: "us-east-1",
            profile: "engineering",
          },
        }),
      },
    ])
    expect(JSON.stringify(calls)).not.toContain("accessKeyId")
    expect(JSON.stringify(calls)).not.toContain("secretAccessKey")
  })

  it("reconstructs a stream and forwards aborts by request id", async () => {
    const calls: string[] = []
    let listener: ((event: ClaudeEvent) => void) | undefined
    const client = createSidecarFeatureCallClient({
      randomUUID: () => "stream-1",
      subscribe: async (_event, handler) => {
        listener = handler
        return () => undefined
      },
      call: async (command) => {
        calls.push(command)
      },
    })
    const controller = new AbortController()
    const model = client.languageModel({
      modelId: "us.amazon.nova-lite-v1:0",
      credentials: {
        protocol: "bedrock",
        bedrockAuthMode: "default-chain",
        region: "us-east-1",
      },
    })
    const result = await model.doStream({ prompt: [], abortSignal: controller.signal } as never)
    const reader = result.stream.getReader()
    listener?.({
      type: "feature_call_stream",
      requestId: "stream-1",
      part: { type: "text-delta", id: "1", delta: "hello" },
    })
    const first = await reader.read()
    expect(first.value).toEqual({ type: "text-delta", id: "1", delta: "hello" })
    controller.abort()
    await Promise.resolve()
    expect(calls).toEqual(["claude_feature_call", "claude_feature_abort"])
  })

  it("proxies embedding batches through the same correlated channel", async () => {
    let listener: ((event: ClaudeEvent) => void) | undefined
    const client = createSidecarFeatureCallClient({
      randomUUID: () => "embed-1",
      subscribe: async (_event, handler) => {
        listener = handler
        return () => undefined
      },
      call: async () => {
        queueMicrotask(() =>
          listener?.({
            type: "feature_call_result",
            requestId: "embed-1",
            result: { embeddings: [{ values: [0.2, 0.8] }], warnings: [] },
          })
        )
      },
    })
    const model = client.embeddingModel({
      modelId: "amazon.titan-embed-text-v2:0",
      credentials: {
        bedrockAuthMode: "default-chain",
        region: "us-east-1",
      },
    })
    await expect(model.doEmbed({ values: ["safe text"] })).resolves.toEqual({
      embeddings: [{ values: [0.2, 0.8] }],
      warnings: [],
    })
  })
})

describe("OpenCode V2 discovery validation", () => {
  it("keeps ephemeral string headers and normalizes the endpoint", () => {
    expect(
      validateOpenCodeV2Discovery({
        endpoint: "http://127.0.0.1:4096/",
        version: "2.0.0-beta.1",
        headers: {
          authorization: "Bearer ephemeral",
          "x-number": 1,
          "": "ignored",
        },
      })
    ).toEqual({
      endpoint: "http://127.0.0.1:4096",
      version: "2.0.0-beta.1",
      headers: { authorization: "Bearer ephemeral" },
    })
  })

  it("rejects missing versions and non-HTTP endpoints", () => {
    expect(() =>
      validateOpenCodeV2Discovery({ endpoint: "http://127.0.0.1:4096", headers: {} })
    ).toThrow("invalid service descriptor")
    expect(() =>
      validateOpenCodeV2Discovery({
        endpoint: "file:///tmp/service.sock",
        version: "2.0.0-beta.1",
      })
    ).toThrow("invalid endpoint")
  })
})

describe("sidecar MCP discovery wrapper", () => {
  const trustedServer: McpServer = {
    id: "srv-1",
    name: "docs",
    transport: "http",
    config: { url: "https://mcp.example/rpc", headers: { authorization: { secretRef: "token" } } },
    enabled: true,
    trust: { state: "trusted" },
    createdAt: 1,
    updatedAt: 1,
  }

  it("resolves secrets only before the ephemeral sidecar request and writes content-free audit", async () => {
    const requests: unknown[] = []
    const audits: unknown[] = []
    const result = await discoverMcpServerViaSidecar(trustedServer, undefined, {
      now: (() => {
        const values = [100, 108]
        return () => values.shift() ?? 108
      })(),
      resolveSecrets: async () => ({
        url: "https://mcp.example/rpc",
        headers: { authorization: "Bearer ephemeral" },
      }),
      requestResult: async (request) => {
        requests.push(request)
        return {
          ok: true,
          toolCount: 1,
          tools: [{ name: "search" }],
          resources: [],
          prompts: [],
          durationMs: 8,
        }
      },
      appendAudit: async (draft) => {
        audits.push(draft)
        return { id: "audit", ...draft }
      },
    })

    expect(result.ok).toBe(true)
    expect(requests).toEqual([
      expect.objectContaining({
        operation: "mcp-discover",
        mcpServer: expect.objectContaining({
          id: "srv-1",
          config: expect.objectContaining({
            headers: { authorization: "Bearer ephemeral" },
          }),
        }),
      }),
    ])
    await Promise.resolve()
    expect(JSON.stringify(audits)).not.toContain("ephemeral")
    expect(audits).toEqual([
      expect.objectContaining({ serverId: "srv-1", phase: "discover", allowed: true }),
    ])
  })

  it("fails closed before resolution or dispatch for pending trust", async () => {
    const requestResult = jest.fn()
    const resolveSecrets = jest.fn()
    const appendAudit = jest.fn(async (draft) => ({ id: "audit", ...draft }))
    const result = await discoverMcpServerViaSidecar(
      { ...trustedServer, trust: { state: "pending" } },
      undefined,
      { requestResult, resolveSecrets, appendAudit, now: () => 100 }
    )

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("pending") })
    expect(requestResult).not.toHaveBeenCalled()
    expect(resolveSecrets).not.toHaveBeenCalled()
    expect(appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ allowed: false, decision: "deny", errorCode: "policy-denied" })
    )
  })
})
