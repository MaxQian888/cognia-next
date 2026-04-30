import {
  textToExternalMessage,
  externalMessageToText,
  extractToolUses,
  extractToolResults,
  acpToolToAgentTool,
  acpToolsToAgentTools,
  toolCallToExternal,
  externalToolUseToToolCall,
  externalResultToSubAgentResult,
  externalTokenUsageToSubAgent,
  subAgentResultToExternal,
  extractResponseFromEvents,
  extractThinkingFromEvents,
  extractToolCallsFromEvents,
  eventsToSteps,
  formatPermissionRequest,
  createTextContent,
  createToolUseContent,
  createToolResultContent,
  hasToolUse,
  hasToolResult,
  getPrimaryText,
  extractToolCallContentText,
  hasDiffContent,
  hasTerminalContent,
  extractDiffs,
  extractLocations,
} from "./translators"
import type {
  ExternalAgentMessage,
  ExternalAgentEvent,
  AcpToolInfo,
  AcpPermissionRequest,
} from "@/types/agent/external-agent"

describe("text/message helpers", () => {
  it("textToExternalMessage builds a text message with default user role", () => {
    const msg = textToExternalMessage("hello")
    expect(msg.role).toBe("user")
    expect(msg.content[0]).toMatchObject({ type: "text", text: "hello" })
    expect(msg.id).toMatch(/^msg_/)
  })

  it("textToExternalMessage honors custom role", () => {
    expect(textToExternalMessage("x", "assistant").role).toBe("assistant")
  })

  it("externalMessageToText joins multiple text parts", () => {
    const msg: ExternalAgentMessage = {
      id: "m1",
      role: "user",
      content: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
        { type: "tool_use", id: "tu", name: "t", input: {}, status: "pending" },
      ],
      timestamp: new Date(),
    }
    expect(externalMessageToText(msg)).toBe("a\nb")
  })

  it("extractToolUses filters tool_use blocks", () => {
    const msg: ExternalAgentMessage = {
      id: "m1",
      role: "user",
      content: [
        { type: "text", text: "a" },
        { type: "tool_use", id: "tu1", name: "tool", input: { a: 1 }, status: "pending" },
      ],
      timestamp: new Date(),
    }
    expect(extractToolUses(msg)).toHaveLength(1)
  })

  it("extractToolResults filters tool_result blocks", () => {
    const msg: ExternalAgentMessage = {
      id: "m1",
      role: "user",
      content: [
        { type: "tool_result", toolUseId: "tu1", content: "ok" },
        { type: "text", text: "ignored" },
      ],
      timestamp: new Date(),
    }
    expect(extractToolResults(msg)).toHaveLength(1)
  })
})

describe("acpToolToAgentTool / acpToolsToAgentTools", () => {
  const baseTool: AcpToolInfo = {
    id: "t1",
    name: "read_file",
    description: "read a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "file path" } },
      required: ["path"],
    },
    requiresPermission: true,
  }

  it("delegates execute to the callback", async () => {
    const cb = jest.fn(async () => "result")
    const tool = acpToolToAgentTool(baseTool, cb)
    expect(tool.requiresApproval).toBe(true)
    expect(tool.name).toBe("read_file")
    const out = await tool.execute({ path: "x" })
    expect(out).toBe("result")
    expect(cb).toHaveBeenCalledWith("t1", "read_file", { path: "x" })
  })

  it("provides a fallback description when omitted", () => {
    const tool = acpToolToAgentTool({ ...baseTool, description: undefined }, async () => "ok")
    expect(tool.description).toMatch(/External tool: read_file/)
  })

  it("acpToolsToAgentTools prefixes tool names with 'external_'", () => {
    const tools = acpToolsToAgentTools([baseTool], async () => "ok")
    expect(Object.keys(tools)).toEqual(["external_read_file"])
  })
})

describe("ToolCall <-> external converters", () => {
  it("toolCallToExternal maps statuses (completed/error/pending)", () => {
    expect(
      toolCallToExternal({
        id: "x",
        name: "n",
        args: { a: 1 },
        status: "completed",
      }).status
    ).toBe("completed")
    expect(toolCallToExternal({ id: "x", name: "n", args: {}, status: "error" }).status).toBe(
      "error"
    )
    expect(toolCallToExternal({ id: "x", name: "n", args: {}, status: "running" }).status).toBe(
      "pending"
    )
  })

  it("externalToolUseToToolCall maps statuses back", () => {
    expect(
      externalToolUseToToolCall({
        type: "tool_use",
        id: "x",
        name: "n",
        input: {},
        status: "completed",
      }).status
    ).toBe("completed")
    expect(
      externalToolUseToToolCall({
        type: "tool_use",
        id: "x",
        name: "n",
        input: {},
        status: "error",
      }).status
    ).toBe("error")
    expect(
      externalToolUseToToolCall({
        type: "tool_use",
        id: "x",
        name: "n",
        input: {},
        status: "pending",
      }).status
    ).toBe("pending")
  })
})

describe("jsonSchemaToZod (via acpToolToAgentTool)", () => {
  function build(schema: Record<string, unknown>) {
    const tool = acpToolToAgentTool(
      {
        id: "t",
        name: "test",
        description: "",
        parameters: schema,
        requiresPermission: false,
      },
      async () => ""
    )
    return tool.parameters
  }

  beforeEach(() => {
    jest.spyOn(console, "warn").mockImplementation(() => {})
  })

  it("supports primitive types", () => {
    const z = build({
      properties: {
        s: { type: "string" },
        n: { type: "number" },
        i: { type: "integer" },
        b: { type: "boolean" },
        nul: { type: "null" },
      },
      required: ["s", "n", "i", "b"],
    })
    const r = z.safeParse({ s: "x", n: 1.5, i: 2, b: true, nul: null })
    expect(r.success).toBe(true)
  })

  it("respects string format mappings: email, url, uuid, datetime, ipv4, ipv6", () => {
    const z = build({
      properties: {
        a: { type: "string", format: "email" },
        b: { type: "string", format: "uri" },
        c: { type: "string", format: "uuid" },
        d: { type: "string", format: "date-time" },
        e: { type: "string", format: "ipv4" },
        f: { type: "string", format: "ipv6" },
        g: { type: "string", format: "unknown-format" },
      },
      required: [],
    })
    const ok = z.safeParse({
      a: "x@x.com",
      b: "https://x",
      c: "00000000-0000-4000-8000-000000000000",
      d: "2025-01-01T00:00:00.000Z",
      e: "1.2.3.4",
      f: "::1",
      g: "anything",
    })
    expect(ok.success).toBe(true)
    const bad = z.safeParse({ a: "not-email" })
    expect(bad.success).toBe(false)
  })

  it("respects string min/max/pattern", () => {
    const z = build({
      properties: {
        s: { type: "string", minLength: 2, maxLength: 4, pattern: "^[a-z]+$" },
      },
      required: ["s"],
    })
    expect(z.safeParse({ s: "ab" }).success).toBe(true)
    expect(z.safeParse({ s: "a" }).success).toBe(false)
    expect(z.safeParse({ s: "abcde" }).success).toBe(false)
    expect(z.safeParse({ s: "AB" }).success).toBe(false)
  })

  it("respects number constraints inclusive/exclusive and multipleOf", () => {
    const z = build({
      properties: {
        a: { type: "number", minimum: 1, maximum: 5, multipleOf: 0.5 },
        b: { type: "number", exclusiveMinimum: 1, exclusiveMaximum: 5 },
        c: { type: "number", minimum: 1, exclusiveMinimum: true },
        d: { type: "number", maximum: 5, exclusiveMaximum: true },
      },
      required: [],
    })
    expect(z.safeParse({ a: 1.5, b: 2, c: 2, d: 4 }).success).toBe(true)
    expect(z.safeParse({ a: 0 }).success).toBe(false)
    expect(z.safeParse({ b: 1 }).success).toBe(false)
    expect(z.safeParse({ c: 1 }).success).toBe(false)
    expect(z.safeParse({ d: 5 }).success).toBe(false)
  })

  it("supports array minItems / maxItems", () => {
    const z = build({
      properties: { tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 } },
      required: ["tags"],
    })
    expect(z.safeParse({ tags: ["a"] }).success).toBe(true)
    expect(z.safeParse({ tags: [] }).success).toBe(false)
    expect(z.safeParse({ tags: ["a", "b", "c"] }).success).toBe(false)
  })

  it("treats array without items as z.unknown()", () => {
    const z = build({
      properties: { unbounded: { type: "array" } },
      required: ["unbounded"],
    })
    expect(z.safeParse({ unbounded: [1, "a", null] }).success).toBe(true)
  })

  it("supports enum (string and mixed types)", () => {
    const z = build({
      properties: {
        color: { type: "string", enum: ["red", "blue"] },
        mixed: { enum: [1, "two", true] },
      },
      required: [],
    })
    expect(z.safeParse({ color: "red", mixed: 1 }).success).toBe(true)
    expect(z.safeParse({ color: "green" }).success).toBe(false)
  })

  it("supports const literal", () => {
    const z = build({
      properties: {
        a: { const: "fixed" },
        b: { const: 7 },
        c: { const: null },
      },
      required: ["a", "b", "c"],
    })
    expect(z.safeParse({ a: "fixed", b: 7, c: null }).success).toBe(true)
    expect(z.safeParse({ a: "other", b: 7, c: null }).success).toBe(false)
  })

  it("supports nullable union types: type: ['string','null']", () => {
    const z = build({
      properties: {
        a: { type: ["string", "null"] },
        b: { type: ["string", "number"] },
        c: { type: ["null"] },
      },
      required: [],
    })
    expect(z.safeParse({ a: null, b: "x", c: null }).success).toBe(true)
    expect(z.safeParse({ a: "x", b: 1, c: null }).success).toBe(true)
  })

  it("supports OpenAPI nullable: true", () => {
    const z = build({
      properties: { a: { type: "string", nullable: true } },
      required: ["a"],
    })
    expect(z.safeParse({ a: null }).success).toBe(true)
    expect(z.safeParse({ a: "ok" }).success).toBe(true)
  })

  it("supports oneOf and anyOf", () => {
    const z = build({
      properties: {
        a: { oneOf: [{ type: "string" }, { type: "number" }] },
        b: { anyOf: [{ type: "boolean" }] },
        c: { oneOf: [] },
      },
      required: [],
    })
    expect(z.safeParse({ a: "x", b: true }).success).toBe(true)
    expect(z.safeParse({ a: 1, b: false }).success).toBe(true)
  })

  it("supports allOf", () => {
    const z = build({
      properties: {
        a: {
          allOf: [
            { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
            { type: "object", properties: { y: { type: "number" } }, required: ["y"] },
          ],
        },
        b: { allOf: [{ type: "string" }] },
        c: { allOf: [] },
      },
      required: [],
    })
    expect(z.safeParse({ a: { x: "ok", y: 1 }, b: "z" }).success).toBe(true)
  })

  it("supports descriptions and optional fields", () => {
    const z = build({
      properties: {
        a: { type: "string", description: "doc" },
      },
    })
    expect(z.safeParse({}).success).toBe(true)
  })

  it("resolves $ref and circular references via z.lazy", () => {
    const root = {
      properties: {
        node: { $ref: "#/$defs/Node" },
      },
      required: ["node"],
      $defs: {
        Node: {
          type: "object",
          properties: {
            value: { type: "string" },
            child: { $ref: "#/$defs/Node" },
          },
          required: ["value"],
        },
      },
    }
    const z = build(root)
    expect(z.safeParse({ node: { value: "n1", child: { value: "n2" } } }).success).toBe(true)
  })

  it("falls back to unknown for non-local $ref", () => {
    const z = build({ properties: { a: { $ref: "https://example/schema" } } })
    expect(z.safeParse({ a: { anything: true } }).success).toBe(true)
  })

  it("returns record schema for object without properties + additionalProperties", () => {
    const z = build({
      properties: {
        m: { type: "object", additionalProperties: { type: "string" } },
        n: { type: "object" },
      },
      required: [],
    })
    expect(z.safeParse({ m: { a: "x" }, n: { anything: 1 } }).success).toBe(true)
  })

  it("falls back to unknown for unrecognized constructs", () => {
    const z = build({
      properties: {
        a: { weird: true } as Record<string, unknown>,
        b: { type: "unknown-type" } as Record<string, unknown>,
      },
      required: [],
    })
    expect(z.safeParse({ a: 1, b: "x" }).success).toBe(true)
  })
})

describe("result/token translators", () => {
  it("externalResultToSubAgentResult maps steps and tool calls", () => {
    const result = externalResultToSubAgentResult(
      {
        success: true,
        sessionId: "s1",
        finalResponse: "done",
        messages: [],
        steps: [
          {
            id: "step_1",
            stepNumber: 1,
            type: "message",
            status: "completed",
            content: [{ type: "text", text: "hi" }],
            startedAt: new Date(0),
            duration: 100,
          },
          {
            id: "step_2",
            stepNumber: 2,
            type: "tool_call",
            status: "completed",
            toolCall: { id: "tc1", name: "tool", input: { a: 1 } },
            startedAt: new Date(0),
            duration: 50,
          },
        ],
        toolCalls: [
          { id: "tc1", name: "tool", input: { a: 1 }, result: "ok", status: "completed" },
        ],
        duration: 200,
        tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        output: "out",
      },
      "sub-1"
    )
    expect(result.success).toBe(true)
    expect(result.totalSteps).toBe(2)
    expect(result.toolResults).toHaveLength(1)
    expect(result.tokenUsage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 })
    expect(result.steps[1].toolCalls).toHaveLength(1)
  })

  it("externalResultToSubAgentResult handles missing optional fields", () => {
    const result = externalResultToSubAgentResult(
      {
        success: false,
        sessionId: "s1",
        finalResponse: "",
        messages: [],
        steps: [],
        toolCalls: [],
        duration: 0,
        error: "boom",
      },
      "sub-1"
    )
    expect(result.tokenUsage).toBeUndefined()
    expect(result.error).toBe("boom")
  })

  it("externalTokenUsageToSubAgent passes tokens through", () => {
    expect(
      externalTokenUsageToSubAgent({ promptTokens: 1, completionTokens: 2, totalTokens: 3 })
    ).toEqual({
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
    })
  })

  it("subAgentResultToExternal handles all fields", () => {
    const out = subAgentResultToExternal(
      {
        success: true,
        finalResponse: "ok",
        steps: [],
        totalSteps: 0,
        duration: 100,
        toolResults: [{ toolCallId: "x", toolName: "t", result: "r" }],
        tokenUsage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      },
      "session-1"
    )
    expect(out.toolCalls).toHaveLength(1)
    expect(out.tokenUsage?.totalTokens).toBe(3)
    expect(out.duration).toBe(100)
  })

  it("subAgentResultToExternal handles minimal input", () => {
    const out = subAgentResultToExternal(
      { success: false, finalResponse: undefined, steps: [], totalSteps: 0 } as never,
      "s1"
    )
    expect(out.finalResponse).toBe("")
    expect(out.toolCalls).toEqual([])
    expect(out.duration).toBe(0)
    expect(out.tokenUsage).toBeUndefined()
  })
})

describe("event translators", () => {
  function buildEvents(): ExternalAgentEvent[] {
    return [
      { type: "message_start", messageId: "m1", timestamp: new Date(0) },
      {
        type: "message_delta",
        messageId: "m1",
        delta: { type: "text", text: "Hello " },
        timestamp: new Date(1),
      },
      {
        type: "message_delta",
        messageId: "m1",
        delta: { type: "text", text: "world" },
        timestamp: new Date(2),
      },
      {
        type: "message_delta",
        messageId: "m1",
        delta: { type: "thinking", text: "thinking..." },
        timestamp: new Date(3),
      },
      { type: "message_end", messageId: "m1", timestamp: new Date(4) },
      { type: "thinking", thinking: "deep", timestamp: new Date(5) },
      {
        type: "tool_use_start",
        toolUseId: "tu1",
        toolName: "tool",
        timestamp: new Date(6),
      },
      {
        type: "tool_use_end",
        toolUseId: "tu1",
        input: { a: 1 },
        timestamp: new Date(7),
      },
      {
        type: "tool_result",
        toolUseId: "tu1",
        result: "ok",
        isError: false,
        timestamp: new Date(8),
      },
      {
        type: "tool_use_start",
        toolUseId: "tu2",
        toolName: "fail",
        timestamp: new Date(9),
      },
      {
        type: "tool_result",
        toolUseId: "tu2",
        result: { err: 1 },
        isError: true,
        timestamp: new Date(10),
      },
      { type: "error", error: "boom", timestamp: new Date(11) },
    ] as ExternalAgentEvent[]
  }

  it("extractResponseFromEvents concatenates text deltas", () => {
    expect(extractResponseFromEvents(buildEvents())).toBe("Hello world")
  })

  it("extractThinkingFromEvents merges thinking events and thinking deltas", () => {
    const out = extractThinkingFromEvents(buildEvents())
    expect(out).toContain("deep")
    expect(out).toContain("thinking...")
  })

  it("extractToolCallsFromEvents reconstructs tool calls", () => {
    const out = extractToolCallsFromEvents(buildEvents())
    expect(out).toHaveLength(2)
    expect(out[0].input).toEqual({ a: 1 })
    expect(out[0].result).toBe("ok")
    expect(out[1].isError).toBe(true)
  })

  it("eventsToSteps builds message/tool/thinking/error steps", () => {
    const steps = eventsToSteps(buildEvents())
    const types = steps.map((s) => s.type)
    expect(types).toEqual(expect.arrayContaining(["message", "thinking", "tool_call"]))
    const completedTool = steps.find((s) => s.toolCall?.id === "tu1")
    expect(completedTool?.status).toBe("completed")
    const failedTool = steps.find((s) => s.toolCall?.id === "tu2")
    expect(failedTool?.status).toBe("failed")
    expect(failedTool?.toolResult?.isError).toBe(true)
    const messageStep = steps.find((s) => s.type === "message")
    expect(messageStep?.duration).toBeDefined()
    // Last error event marks the most recent tool_call as failed
    expect(steps[steps.length - 1].error).toBe("boom")
  })

  it("eventsToSteps handles message_delta when current step is missing", () => {
    const steps = eventsToSteps([
      {
        type: "message_delta",
        messageId: "m1",
        delta: { type: "text", text: "stray" },
        timestamp: new Date(0),
      },
    ] as ExternalAgentEvent[])
    expect(steps).toHaveLength(0)
  })

  it("eventsToSteps merges sequential text deltas into one entry", () => {
    const steps = eventsToSteps([
      { type: "message_start", messageId: "m1", timestamp: new Date(0) },
      {
        type: "message_delta",
        messageId: "m1",
        delta: { type: "text", text: "a" },
        timestamp: new Date(1),
      },
      {
        type: "message_delta",
        messageId: "m1",
        delta: { type: "text", text: "b" },
        timestamp: new Date(2),
      },
    ] as ExternalAgentEvent[])
    expect(steps[0].content).toEqual([{ type: "text", text: "ab" }])
  })
})

describe("formatPermissionRequest", () => {
  function makeReq(overrides: Partial<AcpPermissionRequest> = {}): AcpPermissionRequest {
    return {
      requestId: "r1",
      sessionId: "s1",
      toolInfo: { id: "t1", name: "delete", description: "Delete file" },
      reason: "User-supplied reason",
      riskLevel: "high",
      ...overrides,
    } as AcpPermissionRequest
  }

  it("maps the tool name and risk label", () => {
    const out = formatPermissionRequest(makeReq())
    expect(out.toolName).toBe("delete")
    expect(out.riskLevel).toBe("High Risk")
  })

  it("falls back to a default description when reason is omitted", () => {
    const out = formatPermissionRequest(makeReq({ reason: undefined }))
    expect(out.description).toMatch(/wants to use the "delete" tool/)
  })

  it("uses 'Medium Risk' when riskLevel is missing", () => {
    const out = formatPermissionRequest(makeReq({ riskLevel: undefined }))
    expect(out.riskLevel).toBe("Medium Risk")
  })

  it("falls back to 'Unknown Risk' for an unknown risk level", () => {
    const out = formatPermissionRequest(makeReq({ riskLevel: "weird" as never }))
    expect(out.riskLevel).toBe("Unknown Risk")
  })
})

describe("content helpers", () => {
  it("createTextContent / createToolUseContent / createToolResultContent build expected shapes", () => {
    expect(createTextContent("hi")).toEqual({ type: "text", text: "hi" })
    expect(createToolUseContent("id", "n", { a: 1 })).toEqual({
      type: "tool_use",
      id: "id",
      name: "n",
      input: { a: 1 },
      status: "pending",
    })
    expect(createToolResultContent("tu", "ok").isError).toBe(false)
    expect(createToolResultContent("tu", { error: 1 }, true).isError).toBe(true)
  })

  it("hasToolUse / hasToolResult / getPrimaryText", () => {
    const content = [
      { type: "text" as const, text: "hi" },
      { type: "tool_use" as const, id: "x", name: "n", input: {}, status: "pending" as const },
      { type: "tool_result" as const, toolUseId: "x", content: "ok" },
    ]
    expect(hasToolUse(content)).toBe(true)
    expect(hasToolResult(content)).toBe(true)
    expect(getPrimaryText(content)).toBe("hi")
    expect(
      getPrimaryText([
        { type: "tool_use" as const, id: "x", name: "n", input: {}, status: "pending" as const },
      ])
    ).toBe("")
  })

  it("hasToolUse / hasToolResult are false when no matching block exists", () => {
    expect(hasToolUse([{ type: "text" as const, text: "x" }])).toBe(false)
    expect(hasToolResult([{ type: "text" as const, text: "x" }])).toBe(false)
  })
})

describe("ACP tool-call content helpers", () => {
  it("extractToolCallContentText extracts content/diff/terminal entries", () => {
    const out = extractToolCallContentText([
      { type: "content", content: { text: "hello" } },
      { type: "diff", path: "/x.ts" },
      { type: "terminal", terminalId: "t1" },
      { type: "other" },
    ])
    expect(out).toBe("hello\n[Diff: /x.ts]\n[Terminal: t1]")
  })

  it("extractToolCallContentText returns empty string for empty content", () => {
    expect(extractToolCallContentText([])).toBe("")
  })

  it("hasDiffContent and hasTerminalContent detect entries", () => {
    expect(hasDiffContent([{ type: "diff" }])).toBe(true)
    expect(hasDiffContent([{ type: "content" }])).toBe(false)
    expect(hasDiffContent(undefined)).toBe(false)
    expect(hasTerminalContent([{ type: "terminal" }])).toBe(true)
    expect(hasTerminalContent(undefined)).toBe(false)
  })

  it("extractDiffs extracts diff entries", () => {
    const diffs = extractDiffs([
      { type: "diff", path: "/a.ts", oldText: "a", newText: "b" },
      { type: "diff", path: "/b.ts", oldText: null, newText: "x" },
      { type: "content" },
    ])
    expect(diffs).toEqual([
      { path: "/a.ts", oldText: "a", newText: "b" },
      { path: "/b.ts", oldText: null, newText: "x" },
    ])
  })

  it("extractDiffs returns empty array when content missing", () => {
    expect(extractDiffs(undefined)).toEqual([])
  })

  it("extractLocations passes through or returns empty", () => {
    expect(extractLocations([{ path: "/x", line: 1 }])).toEqual([{ path: "/x", line: 1 }])
    expect(extractLocations(undefined)).toEqual([])
  })
})
