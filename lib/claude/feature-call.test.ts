import { createSidecarFeatureCallClient } from "./feature-call"
import type { ClaudeEvent } from "@cognia/agent-config-types"

describe("sidecar feature-call LanguageModelV3 proxy", () => {
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
