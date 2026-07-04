import * as sdk from "./protocol-adapter"
import type {
  CodeAdapterChunk,
  CodeAdapterRequest,
  CodeProtocolAdapterFactory,
  CodeProtocolAdapterLike,
  PluginProtocolAdapterDef,
  ProtocolAdapterSpec,
  ProtocolAdaptersBridgeOptions,
  ProtocolAdaptersBridgeResult,
} from "./protocol-adapter"

describe("plugin-sdk api/protocol-adapter", () => {
  it("exposes the authoring helper, manifest bridge, registry, and code executors", () => {
    expect(typeof sdk.defineProtocolAdapter).toBe("function")
    expect(typeof sdk.registerProtocolAdaptersForPlugin).toBe("function")
    expect(typeof sdk.unregisterProtocolAdaptersForPlugin).toBe("function")
    expect(typeof sdk.registerProtocolAdapter).toBe("function")
    expect(typeof sdk.unregisterProtocolAdapter).toBe("function")
    expect(typeof sdk.unregisterProtocolAdaptersByPlugin).toBe("function")
    expect(typeof sdk.listProtocolAdapters).toBe("function")
    expect(typeof sdk.getProtocolAdapter).toBe("function")
    expect(typeof sdk.registerCodeAdapterExecutor).toBe("function")
    expect(typeof sdk.getCodeAdapterExecutor).toBe("function")
    expect(typeof sdk.unregisterCodeAdapterExecutor).toBe("function")
    expect(typeof sdk.unregisterCodeAdapterExecutorsByPlugin).toBe("function")
  })

  it("re-exports protocol adapter manifest, bridge, and executor types", () => {
    const assertTypes = <
      _T extends
        | PluginProtocolAdapterDef
        | ProtocolAdapterSpec
        | CodeAdapterChunk
        | CodeAdapterRequest
        | CodeProtocolAdapterLike
        | CodeProtocolAdapterFactory
        | ProtocolAdaptersBridgeOptions
        | ProtocolAdaptersBridgeResult,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })

  it("types AI SDK stream chunks that code adapters may yield", () => {
    type StartChunk = Extract<CodeAdapterChunk, { type: "start" }>
    type TextStartChunk = Extract<CodeAdapterChunk, { type: "text-start" }>
    type TextEndChunk = Extract<CodeAdapterChunk, { type: "text-end" }>
    type TextDeltaChunk = Extract<CodeAdapterChunk, { type: "text-delta" }>
    type ReasoningStartChunk = Extract<CodeAdapterChunk, { type: "reasoning-start" }>
    type ReasoningEndChunk = Extract<CodeAdapterChunk, { type: "reasoning-end" }>
    type ReasoningDeltaChunk = Extract<CodeAdapterChunk, { type: "reasoning-delta" }>
    type ToolInputStartChunk = Extract<CodeAdapterChunk, { type: "tool-input-start" }>
    type ToolInputDeltaChunk = Extract<CodeAdapterChunk, { type: "tool-input-delta" }>
    type ToolCallChunk = Extract<CodeAdapterChunk, { type: "tool-call" }>
    type ToolResultChunk = Extract<CodeAdapterChunk, { type: "tool-result" }>
    type ToolErrorChunk = Extract<CodeAdapterChunk, { type: "tool-error" }>
    type FileChunk = Extract<CodeAdapterChunk, { type: "file" }>
    type ApprovalChunk = Extract<CodeAdapterChunk, { type: "tool-approval-request" }>
    type ToolOutputDeniedChunk = Extract<CodeAdapterChunk, { type: "tool-output-denied" }>
    type ToolInputAvailableChunk = Extract<CodeAdapterChunk, { type: "tool-input-available" }>
    type ToolInputErrorChunk = Extract<CodeAdapterChunk, { type: "tool-input-error" }>
    type ToolOutputAvailableChunk = Extract<CodeAdapterChunk, { type: "tool-output-available" }>
    type ToolOutputErrorChunk = Extract<CodeAdapterChunk, { type: "tool-output-error" }>
    type StartStepChunk = Extract<CodeAdapterChunk, { type: "start-step" }>
    type FinishStepChunk = Extract<CodeAdapterChunk, { type: "finish-step" }>
    type AbortChunk = Extract<CodeAdapterChunk, { type: "abort" }>
    type RawChunk = Extract<CodeAdapterChunk, { type: "raw" }>
    type SourceUrlChunk = Extract<CodeAdapterChunk, { type: "source-url" }>
    type SourceDocumentChunk = Extract<CodeAdapterChunk, { type: "source-document" }>
    type MessageMetadataChunk = Extract<CodeAdapterChunk, { type: "message-metadata" }>
    type FinishChunk = Extract<CodeAdapterChunk, { type: "finish" }>

    const start: StartChunk = {
      type: "start",
      messageId: "sdk-message-1",
      messageMetadata: { phase: "start" },
    }
    const textStart: TextStartChunk = {
      type: "text-start",
      id: "text-1",
      providerMetadata: { provider: { traceId: "trace-text" } },
    }
    const textDelta: TextDeltaChunk = {
      type: "text-delta",
      id: "text-1",
      text: "hello",
      providerMetadata: { provider: { traceId: "trace-text-delta" } },
    }
    const textEnd: TextEndChunk = { type: "text-end", id: "text-1" }
    const reasoningStart: ReasoningStartChunk = { type: "reasoning-start", id: "reasoning-1" }
    const reasoningDelta: ReasoningDeltaChunk = {
      type: "reasoning-delta",
      id: "reasoning-1",
      text: "thinking",
      providerMetadata: { provider: { traceId: "trace-reasoning-delta" } },
    }
    const reasoningEnd: ReasoningEndChunk = { type: "reasoning-end", id: "reasoning-1" }
    const uiToolInputStart: ToolInputStartChunk = {
      type: "tool-input-start",
      toolCallId: "tool-1",
      toolName: "write",
      providerExecuted: false,
      providerMetadata: { provider: { traceId: "trace-1" } },
      toolMetadata: { display: "Write file" },
      dynamic: true,
      title: "Write file",
    }
    const uiToolInputDelta: ToolInputDeltaChunk = {
      type: "tool-input-delta",
      toolCallId: "tool-1",
      inputTextDelta: '{"path":"a"}',
    }
    const toolCall: ToolCallChunk = {
      type: "tool-call",
      toolCallId: "tool-1",
      toolName: "write",
      input: { path: "a" },
      providerMetadata: { provider: { traceId: "trace-tool-call" } },
      toolMetadata: { display: "Write file" },
      dynamic: false,
      title: "Write file",
    }
    const file: FileChunk = {
      type: "file",
      url: "https://files.example/a.png",
      mediaType: "image/png",
      providerMetadata: { provider: { traceId: "trace-file-url" } },
    }
    const approval: ApprovalChunk = {
      type: "tool-approval-request",
      approvalId: "approval-1",
      signature: "sig-1",
      toolCall,
    }
    const uiApproval: ApprovalChunk = {
      type: "tool-approval-request",
      approvalId: "approval-ui-1",
      toolCallId: "tool-1",
      signature: "sig-ui-1",
    }
    const outputDenied: ToolOutputDeniedChunk = {
      type: "tool-output-denied",
      toolCallId: "tool-1",
      toolName: "write",
      providerExecuted: false,
      dynamic: false,
    }
    const toolResult: ToolResultChunk = {
      type: "tool-result",
      toolCallId: "tool-1",
      toolName: "write",
      input: { path: "a" },
      output: { ok: true },
      providerMetadata: { provider: { traceId: "trace-tool-result" } },
      toolMetadata: { display: "Write file" },
      dynamic: false,
      preliminary: false,
      title: "Write file",
    }
    const toolError: ToolErrorChunk = {
      type: "tool-error",
      toolCallId: "tool-1",
      toolName: "write",
      input: { path: "a" },
      error: new Error("write failed"),
      providerMetadata: { provider: { traceId: "trace-tool-error" } },
      toolMetadata: { display: "Write file" },
      dynamic: false,
      title: "Write file",
    }
    const inputAvailable: ToolInputAvailableChunk = {
      type: "tool-input-available",
      toolCallId: "tool-1",
      toolName: "write",
      input: { path: "a" },
      providerExecuted: false,
      providerMetadata: { provider: { traceId: "trace-3" } },
      toolMetadata: { display: "Write file" },
      dynamic: true,
      title: "Write file",
    }
    const inputError: ToolInputErrorChunk = {
      type: "tool-input-error",
      toolCallId: "tool-2",
      toolName: "write",
      input: { path: 123 },
      errorText: "invalid input",
    }
    const outputAvailable: ToolOutputAvailableChunk = {
      type: "tool-output-available",
      toolCallId: "tool-1",
      output: { ok: true },
      preliminary: false,
    }
    const outputError: ToolOutputErrorChunk = {
      type: "tool-output-error",
      toolCallId: "tool-1",
      errorText: "write failed",
      providerExecuted: false,
    }
    const startStep: StartStepChunk = {
      type: "start-step",
      request: { body: { model: "test" } },
      warnings: [],
    }
    const finishStep: FinishStepChunk = {
      type: "finish-step",
      usage: { inputTokens: 10, outputTokens: 5 },
      finishReason: "stop",
    }
    const abort: AbortChunk = { type: "abort", reason: "cancelled" }
    const raw: RawChunk = { type: "raw", rawValue: { vendor: "frame" } }
    const sourceUrl: SourceUrlChunk = {
      type: "source-url",
      sourceId: "src-url-1",
      url: "https://example.com",
      title: "Example",
      providerMetadata: { provider: { traceId: "trace-source-url" } },
    }
    const sourceDocument: SourceDocumentChunk = {
      type: "source-document",
      sourceId: "src-doc-1",
      mediaType: "application/pdf",
      title: "Spec.pdf",
      filename: "Spec.pdf",
      providerMetadata: { provider: { traceId: "trace-source-doc" } },
    }
    const messageMetadata: MessageMetadataChunk = {
      type: "message-metadata",
      messageMetadata: { phase: "stream" },
    }
    const finish: FinishChunk = {
      type: "finish",
      finishReason: "stop",
      messageMetadata: { phase: "finish" },
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        cachedInputTokens: 2,
        cacheCreationInputTokens: 1,
        reasoningTokens: 3,
      },
      totalUsage: {
        inputTokens: 12,
        outputTokens: 6,
        inputTokenDetails: { cacheReadTokens: 4, cacheWriteTokens: 1 },
        outputTokenDetails: { reasoningTokens: 2 },
      },
    }

    const chunks: CodeAdapterChunk[] = [
      start,
      textStart,
      textDelta,
      textEnd,
      reasoningStart,
      reasoningDelta,
      reasoningEnd,
      uiToolInputStart,
      uiToolInputDelta,
      { type: "tool-input-start", id: "tool-1", toolName: "write" },
      { type: "tool-input-delta", id: "tool-1", delta: '{"path":"a"}' },
      toolCall,
      toolResult,
      toolError,
      approval,
      uiApproval,
      outputDenied,
      inputAvailable,
      inputError,
      outputAvailable,
      outputError,
      startStep,
      finishStep,
      abort,
      raw,
      { type: "tool-output-denied", toolCallId: "tool-1", toolName: "write" },
      {
        type: "file",
        file: { base64: "QUJD", mediaType: "image/png" },
        filename: "a.png",
        providerMetadata: { provider: { traceId: "trace-file-generated" } },
      },
      file,
      sourceUrl,
      sourceDocument,
      messageMetadata,
      { type: "error", error: new Error("upstream failed") },
      finish,
    ]

    expect(chunks).toHaveLength(33)
    expect(start.type).toBe("start")
    expect(start.messageId).toBe("sdk-message-1")
    expect(start.messageMetadata).toEqual({ phase: "start" })
    expect(textStart.providerMetadata?.provider.traceId).toBe("trace-text")
    expect(textDelta.providerMetadata?.provider.traceId).toBe("trace-text-delta")
    expect(textEnd.id).toBe("text-1")
    expect(reasoningStart.id).toBe("reasoning-1")
    expect(reasoningDelta.providerMetadata?.provider.traceId).toBe("trace-reasoning-delta")
    expect(reasoningEnd.id).toBe("reasoning-1")
    expect(uiToolInputStart.toolCallId).toBe("tool-1")
    expect(uiToolInputDelta.inputTextDelta).toBe('{"path":"a"}')
    expect(toolCall.toolName).toBe("write")
    expect(toolCall.providerMetadata?.provider.traceId).toBe("trace-tool-call")
    expect(toolResult.providerMetadata?.provider.traceId).toBe("trace-tool-result")
    expect(toolError.providerMetadata?.provider.traceId).toBe("trace-tool-error")
    expect(file.mediaType).toBe("image/png")
    expect(file.providerMetadata?.provider.traceId).toBe("trace-file-url")
    expect(approval.toolCall.toolCallId).toBe("tool-1")
    expect(uiApproval.toolCallId).toBe("tool-1")
    expect(outputDenied.toolCallId).toBe("tool-1")
    expect(inputAvailable.input).toEqual({ path: "a" })
    expect(inputError.errorText).toBe("invalid input")
    expect(outputAvailable.output).toEqual({ ok: true })
    expect(outputError.errorText).toBe("write failed")
    expect(startStep.request).toEqual({ body: { model: "test" } })
    expect(finishStep.usage?.inputTokens).toBe(10)
    expect(abort.reason).toBe("cancelled")
    expect(raw.rawValue).toEqual({ vendor: "frame" })
    expect(sourceUrl.providerMetadata?.provider.traceId).toBe("trace-source-url")
    expect(sourceDocument.mediaType).toBe("application/pdf")
    expect(messageMetadata.messageMetadata).toEqual({ phase: "stream" })
    expect(finish.messageMetadata).toEqual({ phase: "finish" })
    expect(finish.totalUsage?.inputTokens).toBe(12)
    expect(finish.usage?.reasoningTokens).toBe(3)
  })

  it("re-exports the IPC-safe code adapter request shape", () => {
    const request: CodeAdapterRequest = {
      model: "acme-1",
      messages: [
        {
          role: "user",
          content: "hi",
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
        },
      ],
      modelParams: { temperature: 0.2 },
      credentials: {
        apiKey: "k",
        baseURL: "https://x",
        protocol: "acme:wire",
        headers: { "x-acme-account": "acct_1" },
        apiFlavor: "responses",
      },
      reasoning: { effort: "high", maxThinkingTokens: 4096 },
      maxSteps: 3,
      abortSignal: new AbortController().signal,
    }

    expect(request.messages[0]?.providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    })
    expect(request.credentials.headers?.["x-acme-account"]).toBe("acct_1")
    expect(request.credentials.apiFlavor).toBe("responses")
    expect(request.reasoning?.effort).toBe("high")
    expect(request.maxSteps).toBe(3)
    expect(request.abortSignal).toBeInstanceOf(AbortSignal)
  })
})
