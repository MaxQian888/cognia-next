import {
  __resetProtocolAdaptersForTesting,
  getCodeAdapterExecutor,
  getProtocolAdapter,
  listProtocolAdapters,
  type CodeAdapterChunk,
  type CodeAdapterRequest,
  type CodeProtocolAdapterFactory,
  type PluginProtocolAdapterDef,
  registerCodeAdapterExecutor,
  registerProtocolAdapter,
  unregisterCodeAdapterExecutorsByPlugin,
  unregisterProtocolAdapter,
  unregisterProtocolAdaptersByPlugin,
} from "./protocol-adapter-registry"

const def = (id: string): PluginProtocolAdapterDef => ({
  id,
  label: `Adapter ${id}`,
  spec: {
    kind: "openai-compatible-variant",
    urlTemplate: "{baseURL}/chat",
    responsePaths: { textDelta: "choices[0].delta.content" },
  },
})

describe("protocol-adapter-registry", () => {
  afterEach(() => __resetProtocolAdaptersForTesting())

  it("registers and resolves a plugin adapter", () => {
    expect(registerProtocolAdapter(def("p1:wire"), { pluginId: "p1" })).toBe(true)
    expect(getProtocolAdapter("p1:wire")?.label).toBe("Adapter p1:wire")
  })

  it("refuses reserved/built-in protocol ids (both naming families)", () => {
    for (const reserved of [
      "openai",
      "anthropic",
      "gemini",
      "google",
      "mistral",
      "cohere",
      "azure",
      "bedrock",
    ]) {
      expect(registerProtocolAdapter(def(reserved))).toBe(false)
      expect(getProtocolAdapter(reserved)).toBeUndefined()
    }
  })

  it("unregisters by id and by plugin", () => {
    registerProtocolAdapter(def("p1:a"), { pluginId: "p1" })
    registerProtocolAdapter(def("p1:b"), { pluginId: "p1" })
    registerProtocolAdapter(def("p2:c"), { pluginId: "p2" })
    expect(unregisterProtocolAdapter("p1:a")).toBe(true)
    expect(unregisterProtocolAdaptersByPlugin("p1")).toBe(1)
    expect(getProtocolAdapter("p2:c")).toBeDefined()
    expect(getProtocolAdapter("p1:b")).toBeUndefined()
  })

  it("lists adapters with plugin attribution", () => {
    registerProtocolAdapter(def("p1:wire"), { pluginId: "p1" })
    expect(listProtocolAdapters()).toEqual([
      { id: "p1:wire", label: "Adapter p1:wire", pluginId: "p1" },
    ])
  })

  it("keeps the first plugin registration when another plugin reuses an id", () => {
    registerProtocolAdapter(def("shared:wire"), { pluginId: "p1" })

    expect(
      registerProtocolAdapter({ ...def("shared:wire"), label: "Second" }, { pluginId: "p2" })
    ).toBe(true)
    expect(getProtocolAdapter("shared:wire")?.label).toBe("Adapter shared:wire")
  })

  describe("code-adapter executors", () => {
    const factory: CodeProtocolAdapterFactory = () => ({
      stream: async function* () {},
    })

    it("registers and resolves a code executor", () => {
      registerCodeAdapterExecutor("p1:code", factory, "p1")
      expect(getCodeAdapterExecutor("p1:code")).toBe(factory)
      expect(getCodeAdapterExecutor("missing")).toBeUndefined()
    })

    it("unregisters every executor of a plugin", () => {
      registerCodeAdapterExecutor("p1:a", factory, "p1")
      registerCodeAdapterExecutor("p1:b", factory, "p1")
      registerCodeAdapterExecutor("p2:c", factory, "p2")
      expect(unregisterCodeAdapterExecutorsByPlugin("p1")).toBe(2)
      expect(getCodeAdapterExecutor("p1:a")).toBeUndefined()
      expect(getCodeAdapterExecutor("p2:c")).toBe(factory)
    })

    it("__reset clears executors too", () => {
      registerCodeAdapterExecutor("p1:x", factory, "p1")
      __resetProtocolAdaptersForTesting()
      expect(getCodeAdapterExecutor("p1:x")).toBeUndefined()
    })
  })

  it("keeps code adapter chunk types explicit for AI SDK stream parts", () => {
    type StartChunk = Extract<CodeAdapterChunk, { type: "start" }>
    type TextStartChunk = Extract<CodeAdapterChunk, { type: "text-start" }>
    type TextEndChunk = Extract<CodeAdapterChunk, { type: "text-end" }>
    type ReasoningStartChunk = Extract<CodeAdapterChunk, { type: "reasoning-start" }>
    type ReasoningEndChunk = Extract<CodeAdapterChunk, { type: "reasoning-end" }>
    type ToolInputStartChunk = Extract<CodeAdapterChunk, { type: "tool-input-start" }>
    type ToolInputDeltaChunk = Extract<CodeAdapterChunk, { type: "tool-input-delta" }>
    type ToolCallChunk = Extract<CodeAdapterChunk, { type: "tool-call" }>
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
    const textEnd: TextEndChunk = { type: "text-end", id: "text-1" }
    const reasoningStart: ReasoningStartChunk = { type: "reasoning-start", id: "reasoning-1" }
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
    }
    const file: FileChunk = {
      type: "file",
      url: "https://files.example/a.png",
      mediaType: "image/png",
    }
    const approval: ApprovalChunk = {
      type: "tool-approval-request",
      approvalId: "approval-1",
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
    const messageMetadata: MessageMetadataChunk = {
      type: "message-metadata",
      messageMetadata: { phase: "stream" },
    }
    const finish: FinishChunk = {
      type: "finish",
      messageMetadata: { phase: "finish" },
      totalUsage: {
        inputTokens: 12,
        outputTokens: 6,
        inputTokenDetails: { cacheReadTokens: 4, cacheWriteTokens: 1 },
        outputTokenDetails: { reasoningTokens: 2 },
      },
    }

    expect(start.type).toBe("start")
    expect(start.messageId).toBe("sdk-message-1")
    expect(start.messageMetadata).toEqual({ phase: "start" })
    expect(textStart.providerMetadata?.provider.traceId).toBe("trace-text")
    expect(textEnd.id).toBe("text-1")
    expect(reasoningStart.id).toBe("reasoning-1")
    expect(reasoningEnd.id).toBe("reasoning-1")
    expect(uiToolInputStart.toolCallId).toBe("tool-1")
    expect(uiToolInputDelta.inputTextDelta).toBe('{"path":"a"}')
    expect(toolCall.toolName).toBe("write")
    expect(file.mediaType).toBe("image/png")
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
    expect(messageMetadata.messageMetadata).toEqual({ phase: "stream" })
    expect(finish.messageMetadata).toEqual({ phase: "finish" })
    expect(finish.totalUsage?.inputTokens).toBe(12)
  })

  it("types IPC-safe code adapter request fields", () => {
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
    expect(request.reasoning?.maxThinkingTokens).toBe(4096)
    expect(request.maxSteps).toBe(3)
    expect(request.abortSignal).toBeInstanceOf(AbortSignal)
  })
})
