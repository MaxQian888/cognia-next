import type { FormInfo, SessionMessageInfo } from "@opencode/client"
import {
  OpenCodeV2EventMapper,
  mapOpenCodeV2Messages,
  type OpenCodeEvent,
} from "./opencode-v2-events"

function event(type: string, data: Record<string, unknown>, created = 1_800_000_000_000) {
  return { id: "evt", type, data, created } as unknown as OpenCodeEvent
}

const scope = { sessionID: "ses_test", assistantMessageID: "msg_test" }

describe("OpenCodeV2EventMapper", () => {
  let mapper: OpenCodeV2EventMapper
  beforeEach(() => {
    mapper = new OpenCodeV2EventMapper("ses_test")
  })

  it("canonicalizes only the current session's mounted Cognia tool namespaces", () => {
    mapper = new OpenCodeV2EventMapper("ses_test", ["cognia-tools"])
    const start = mapper.map(
      event("session.tool.input.started", { ...scope, id: "call", name: "cognia-tools_read" })
    )
    expect(start[0]).toMatchObject({ toolName: "mcp__cognia-tools__read" })
    const permission = mapper.map(
      event("permission.asked", {
        ...scope,
        id: "ask",
        action: "cognia-tools_write",
        resources: [],
      })
    )
    expect(permission[0]).toMatchObject({
      request: { toolInfo: { name: "mcp__cognia-tools__write" } },
    })
    const unmounted = mapper.map(
      event("session.tool.input.started", {
        ...scope,
        id: "other",
        name: "cognia-plugin-tools_ask_user",
      })
    )
    expect(unmounted[0]).toMatchObject({ toolName: "cognia-plugin-tools_ask_user" })
  })

  it("filters global and unrelated session events and rejects old event names", () => {
    expect(mapper.map(event("server.connected", {}))).toEqual([])
    expect(
      mapper.map(event("session.text.delta", { ...scope, sessionID: "other", delta: "no" }))
    ).toEqual([])
    expect(mapper.map(event("session.next.text.delta", { ...scope, delta: "old" }))).toEqual([])
    expect(mapper.map(event("session.idle", scope))).toEqual([])
  })

  it("projects text and reasoning with the actual message id and envelope timestamp", () => {
    expect(mapper.map(event("session.text.started", scope))[0]).toMatchObject({
      type: "message_start",
      messageId: "msg_test",
      role: "assistant",
      timestamp: new Date(1_800_000_000_000),
    })
    expect(mapper.map(event("session.text.delta", { ...scope, delta: "hello" }))[0]).toMatchObject({
      type: "message_delta",
      delta: { type: "text", text: "hello" },
    })
    expect(mapper.map(event("session.text.ended", scope))[0]).toMatchObject({
      type: "message_end",
      messageId: "msg_test",
    })
    expect(
      mapper.map(event("session.reasoning.delta", { ...scope, delta: "reason" }))[0]
    ).toMatchObject({ type: "thinking", thinking: "reason", messageId: "msg_test" })
  })

  it("carries tool identity from streaming input to parsed input and structured output", () => {
    expect(
      mapper.map(event("session.tool.input.started", { ...scope, id: "tool_1", name: "read" }))[0]
    ).toMatchObject({ type: "tool_use_start", toolUseId: "tool_1", toolName: "read" })
    expect(
      mapper.map(
        event("session.tool.input.delta", { ...scope, id: "tool_1", delta: '{"path":' })
      )[0]
    ).toMatchObject({ type: "tool_use_delta", delta: '{"path":' })
    expect(
      mapper.map(
        event("session.tool.called", {
          ...scope,
          id: "tool_1",
          input: { path: "a" },
          executed: true,
        })
      )
    ).toEqual([
      expect.objectContaining({ type: "tool_use_end", toolUseId: "tool_1", input: { path: "a" } }),
    ])
    const content = [
      { type: "text", text: "contents" },
      { type: "file", uri: "file:///a", mime: "text/plain" },
    ]
    expect(
      mapper.map(event("session.tool.success", { ...scope, id: "tool_1", content }))[0]
    ).toMatchObject({ type: "tool_result", toolName: "read", result: { content }, isError: false })
  })

  it("retains a missing tool start as an explicit unknown identity and preserves errors", () => {
    expect(mapper.map(event("session.tool.called", { ...scope, id: "late", input: {} }))).toEqual([
      expect.objectContaining({ type: "tool_use_start", toolName: "unknown", toolUseId: "late" }),
      expect.objectContaining({ type: "tool_use_end", input: {} }),
    ])
    expect(
      mapper.map(
        event("session.tool.failed", {
          ...scope,
          id: "late",
          error: { type: "ToolError", message: "denied" },
        })
      )[0]
    ).toMatchObject({
      type: "tool_result",
      result: { error: { type: "ToolError", message: "denied" } },
      isError: true,
    })
  })

  it("sums unique steps and only completes on execution outcome", () => {
    const first = event("session.step.ended", {
      ...scope,
      finish: "tool-calls",
      cost: 0.25,
      tokens: { input: 2, output: 3, reasoning: 1, cache: { read: 4, write: 5 } },
    })
    expect(mapper.tokenUsage).toBeUndefined()
    expect(mapper.map(first)).toEqual([])
    mapper.map(first)
    mapper.map(
      event("session.step.ended", {
        ...scope,
        assistantMessageID: "msg_2",
        finish: "length",
        cost: 0.5,
        tokens: { input: 5, output: 7, reasoning: 2, cache: { read: 1, write: 2 } },
      })
    )
    expect(mapper.tokenUsage).toEqual({
      promptTokens: 7,
      completionTokens: 13,
      totalTokens: 20,
      reasoningTokens: 3,
      cacheReadTokens: 5,
      cacheWriteTokens: 7,
      providerCost: { amount: 0.75, currency: "USD" },
    })
    expect(mapper.map(event("session.execution.succeeded", scope))).toEqual([
      expect.objectContaining({
        type: "done",
        success: true,
        stopReason: "max_tokens",
        tokenUsage: mapper.tokenUsage,
      }),
    ])
    expect(mapper.map(event("session.execution.succeeded", scope))).toEqual([])
    mapper.map(event("session.execution.started", scope))
    expect(mapper.tokenUsage).toBeUndefined()
    expect(
      mapper.map(event("session.execution.interrupted", { ...scope, reason: "user" }))[0]
    ).toMatchObject({ type: "done", success: false, stopReason: "cancelled" })
  })

  it("exposes step failure without terminating retries and makes execution failure terminal", () => {
    expect(
      mapper.map(
        event("session.step.failed", { ...scope, error: { type: "RateLimit", message: "retry" } })
      )
    ).toEqual([expect.objectContaining({ type: "error", error: "retry", recoverable: true })])
    expect(
      mapper.map(
        event("session.execution.failed", {
          ...scope,
          error: { type: "ProviderError", message: "failed" },
        })
      )
    ).toEqual([
      expect.objectContaining({
        type: "error",
        error: "failed",
        code: "ProviderError",
        recoverable: false,
      }),
      expect.objectContaining({ type: "done", success: false }),
    ])
  })

  it("maps permissions with correlation, resource scope, and response semantics", () => {
    const request = {
      ...scope,
      id: "perm",
      action: "shell",
      resources: ["pwd"],
      save: ["pwd"],
      message: "Review",
      source: { type: "tool", id: "call", messageID: "msg_test" },
    }
    expect(mapper.map(event("permission.asked", request))[0]).toMatchObject({
      type: "permission_request",
      request: {
        id: "perm",
        requestId: "perm",
        toolCallId: "call",
        title: "Review",
        toolInfo: { id: "shell", name: "shell" },
        rawInput: { resources: ["pwd"] },
      },
    })
    expect(
      mapper.map(event("permission.replied", { ...scope, requestID: "perm", reply: "always" }))[0]
    ).toMatchObject({
      type: "permission_response",
      response: { requestId: "perm", granted: true, rememberChoice: true, scope: "always" },
    })
    expect(
      mapper.map(event("permission.replied", { ...scope, requestID: "perm", reply: "reject" }))[0]
    ).toMatchObject({ response: { granted: false, scope: "once" } })
  })

  it("normalizes all native form value types and preserves constraints and the native form", () => {
    const form: FormInfo = {
      id: "form",
      sessionID: "ses_test",
      title: "Details",
      fields: [
        {
          type: "string",
          key: "name",
          title: "Name",
          required: true,
          minLength: 2,
          maxLength: 10,
          pattern: "^[a-z]+$",
          placeholder: "abc",
        },
        {
          type: "string",
          key: "pick",
          options: [{ value: "a", label: "Alpha", description: "first" }],
        },
        { type: "integer", key: "count", minimum: 1, maximum: 10, default: 2 },
        { type: "number", key: "weight", default: 0.5 },
        { type: "boolean", key: "enabled", default: true },
        {
          type: "multiselect",
          key: "tags",
          options: [{ value: "x", label: "X" }],
          minItems: 1,
          maxItems: 2,
          default: ["x"],
        },
      ],
    }
    const result = mapper.map({
      id: "restored",
      type: "form.created",
      created: 1,
      data: { form },
    })[0]
    expect(result).toMatchObject({
      type: "elicitation_request",
      request: {
        id: "form",
        mode: "form",
        raw: { openCodeForm: form },
        requestedSchema: {
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 2, maxLength: 10, pattern: "^[a-z]+$" },
            pick: { oneOf: [{ const: "a", title: "Alpha" }] },
            count: { type: "integer", minimum: 1, maximum: 10, default: 2 },
            weight: { type: "number", default: 0.5 },
            enabled: { type: "boolean", default: true },
            tags: {
              type: "array",
              minItems: 1,
              maxItems: 2,
              items: { type: "string", oneOf: [{ const: "x", title: "X" }] },
            },
          },
        },
      },
    })
    expect(mapper.pendingForms.get("form")).toEqual(form)
    expect(
      mapper.map(event("form.replied", { ...scope, id: "form", answer: {} }))[0]
    ).toMatchObject({ type: "elicitation_complete", elicitationId: "form" })
    expect(mapper.pendingForms.has("form")).toBe(false)
  })

  it.each(["number", "integer"] as const)(
    "explicitly rejects serialized and live nonfinite %s constraints and defaults",
    (type) => {
      for (const key of ["minimum", "maximum", "default"] as const) {
        for (const value of ["Infinity", "-Infinity", "NaN", Infinity, -Infinity, NaN] as const) {
          const form: FormInfo = {
            id: "nonfinite",
            sessionID: "ses_test",
            title: "Number",
            fields: [{ type, key: "value", [key]: value }],
          }
          expect(
            mapper.map({ id: "restored", type: "form.created", created: 1, data: { form } })
          ).toEqual([
            expect.objectContaining({
              type: "error",
              code: "opencode_form_nonfinite_number",
              recoverable: true,
            }),
          ])
          expect(mapper.pendingForms.get(form.id)).toBe(form)
        }
      }
    }
  )

  it("uses the existing URL security normalization for external forms", () => {
    const form = {
      id: "url",
      sessionID: "ses_test",
      title: "Login",
      fields: [{ type: "external", key: "login", url: "https://example.com/login" }],
    }
    expect(mapper.map(event("form.created", { form }))[0]).toMatchObject({
      type: "elicitation_request",
      request: {
        mode: "url",
        origin: "https://example.com",
        url: "https://example.com/login",
        elicitationId: "url",
      },
    })
    expect(mapper.map(event("form.cancelled", { ...scope, id: "url" }))[0]).toMatchObject({
      type: "elicitation_complete",
    })
    expect(
      mapper.map(
        event("form.created", {
          form: {
            ...form,
            fields: [{ type: "external", key: "login", url: "http://example.com" }],
          },
        })
      )[0]
    ).toMatchObject({ type: "error", code: "opencode_form_unsafe_url" })
  })

  it("keeps custom string choices editable and does not claim that step refusal ended execution", () => {
    const form = {
      id: "custom",
      sessionID: "ses_test",
      title: "Label",
      fields: [
        { type: "string", key: "label", custom: true, options: [{ value: "a", label: "A" }] },
      ],
    }
    const request = mapper.map(event("form.created", { form }))[0]
    expect(request.type).toBe("elicitation_request")
    if (request.type === "elicitation_request") {
      expect(request.request.requestedSchema?.properties.label).toMatchObject({
        type: "string",
        custom: true,
        options: form.fields[0].options,
      })
      expect(request.request.requestedSchema?.properties.label.oneOf).toBeUndefined()
    }
    expect(
      mapper.map(
        event("session.step.ended", {
          ...scope,
          finish: "content-filter",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })
      )
    ).toEqual([])
    expect(mapper.map(event("session.execution.succeeded", scope))[0]).toMatchObject({
      stopReason: "refusal",
    })
    expect(mapper.pendingForms.has("custom")).toBe(true)
  })

  it("does not discard conditional or mixed external fields or accept secret collection", () => {
    for (const fields of [
      [{ type: "string", key: "x", when: [{ key: "a", op: "eq", value: true }] }],
      [
        { type: "external", key: "url", url: "https://example.com" },
        { type: "string", key: "text" },
      ],
      [{ type: "string", key: "password" }],
      [{ type: "multiselect", key: "tags", custom: true, options: [] }],
    ]) {
      const form = { id: "blocked", sessionID: "ses_test", title: "Form", fields }
      const result = mapper.map(event("form.created", { form }))
      expect(result).toEqual([expect.objectContaining({ type: "error", recoverable: true })])
      expect(mapper.pendingForms.get("blocked")).toEqual(form)
    }
    expect(
      mapper.map(
        event("form.created", { form: { id: "other", sessionID: "other", title: "x", fields: [] } })
      )
    ).toEqual([])
  })

  it("maps progress and agent selection without treating compaction as execution completion", () => {
    expect(mapper.map(event("session.compaction.started", scope))[0]).toMatchObject({
      type: "progress",
      progress: 0,
    })
    expect(mapper.map(event("session.compaction.ended", scope))[0]).toMatchObject({
      type: "progress",
      progress: 1,
    })
    expect(
      mapper.map(event("session.agent.selected", { ...scope, agent: "plan" }))[0]
    ).toMatchObject({ type: "mode_update", modeId: "plan" })
    expect(mapper.map(event("session.execution.succeeded", scope))[0]).toMatchObject({
      type: "done",
      success: true,
      stopReason: "end_turn",
    })
  })
})

describe("mapOpenCodeV2Messages", () => {
  function messages(...items: Array<Record<string, unknown>>) {
    return items.map((item, index) => ({
      id: `msg_${index}`,
      time: { created: 1_800_000_000_000 + index },
      ...item,
    })) as SessionMessageInfo[]
  }

  it("restores user attachments and assistant text, reasoning, tools, errors, and usage", () => {
    const result = mapOpenCodeV2Messages(
      messages(
        {
          type: "user",
          text: "Review",
          files: [
            { mime: "image/png", data: "aW1n", source: { type: "inline" } },
            { mime: "audio/wav", data: "YXVkaW8=", source: { type: "inline" } },
            {
              mime: "application/pdf",
              data: "cGRm",
              source: { type: "uri", uri: "file:///report.pdf" },
            },
          ],
        },
        {
          type: "assistant",
          content: [
            { type: "text", text: "Result" },
            { type: "reasoning", text: "Reason" },
            {
              type: "tool",
              id: "call",
              name: "read",
              state: {
                status: "completed",
                input: { path: "a" },
                content: [{ type: "text", text: "file" }],
              },
            },
          ],
          error: { type: "ProviderError", message: "partial" },
          cost: 0.25,
          tokens: { input: 2, output: 3, reasoning: 4, cache: { read: 1, write: 0 } },
        }
      )
    )
    expect(result[0]).toMatchObject({
      id: "msg_0",
      role: "user",
      timestamp: new Date(1_800_000_000_000),
      content: [
        { type: "text", text: "Review" },
        { type: "image", source: { type: "base64", data: "aW1n", mediaType: "image/png" } },
        { type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
        {
          type: "resource",
          resource: { uri: "file:///report.pdf", blob: "cGRm", mimeType: "application/pdf" },
        },
      ],
    })
    expect(result[1]).toMatchObject({
      role: "assistant",
      content: [
        { type: "text", text: "Result" },
        { type: "thinking", thinking: "Reason" },
        { type: "tool_use", id: "call", name: "read", status: "completed", input: { path: "a" } },
        {
          type: "tool_result",
          toolUseId: "call",
          content: { content: [{ type: "text", text: "file" }] },
          isError: false,
        },
        { type: "error", error: "partial", code: "ProviderError" },
      ],
      tokenUsage: {
        promptTokens: 2,
        completionTokens: 7,
        reasoningTokens: 4,
        totalTokens: 9,
        providerCost: { amount: 0.25, currency: "USD" },
      },
    })
  })

  it("retains streaming/running/error tools and partial tool input", () => {
    const result = mapOpenCodeV2Messages(
      messages({
        type: "assistant",
        content: [
          {
            type: "tool",
            id: "a",
            name: "shell",
            state: { status: "streaming", input: '{"command":' },
          },
          {
            type: "tool",
            id: "b",
            name: "read",
            state: { status: "running", input: { path: "b" }, metadata: {} },
          },
          {
            type: "tool",
            id: "c",
            name: "read",
            state: {
              status: "error",
              input: {},
              error: { type: "Denied", message: "no" },
              content: [{ type: "text", text: "feedback" }],
            },
          },
        ],
      })
    )
    expect(result[0].content).toEqual([
      expect.objectContaining({
        type: "tool_use",
        id: "a",
        status: "pending",
        input: { raw: '{"command":' },
      }),
      expect.objectContaining({
        type: "tool_use",
        id: "b",
        status: "running",
        input: { path: "b" },
      }),
      expect.objectContaining({ type: "tool_use", id: "c", status: "error" }),
      expect.objectContaining({
        type: "tool_result",
        isError: true,
        content: {
          error: { type: "Denied", message: "no" },
          content: [{ type: "text", text: "feedback" }],
        },
      }),
    ])
  })

  it("preserves system, compaction, shell, and selection history in the supplied order", () => {
    const result = mapOpenCodeV2Messages(
      messages(
        { type: "synthetic", text: "context" },
        { type: "system", text: "system" },
        { type: "skill", skill: "review", name: "Review", text: "skill text" },
        { type: "agent-switched", agent: "plan" },
        { type: "model-switched", model: { providerID: "p", id: "group/model", variant: "high" } },
        { type: "location-switched", location: { directory: "/project" } },
        {
          type: "compaction",
          status: "completed",
          reason: "manual",
          summary: "Summary",
          recent: "Recent",
        },
        {
          type: "compaction",
          status: "failed",
          reason: "manual",
          error: { type: "CompactionError", message: "failed" },
        },
        {
          type: "shell",
          shellID: "shell",
          command: "pwd",
          status: "exited",
          exit: 0,
          output: { output: "/project", cursor: 8, size: 8, truncated: false },
        },
        { type: "shell", shellID: "bad", command: "false", status: "exited", exit: 1 }
      )
    )
    expect(result.map((item) => item.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `msg_${index}`)
    )
    expect(result[4]).toMatchObject({
      role: "system",
      content: [{ type: "text", text: "p/group/model#high" }],
    })
    expect(result[6].content).toEqual([{ type: "text", text: "Summary\n\nRecent" }])
    expect(result[7].content).toEqual([expect.objectContaining({ type: "error", error: "failed" })])
    expect(result[8].content).toEqual([
      expect.objectContaining({ type: "tool_use", name: "shell" }),
      expect.objectContaining({ type: "tool_result", isError: false }),
    ])
    expect(result[9].content[1]).toMatchObject({ type: "tool_result", isError: true })
  })

  it("retains unfinished work and optional native history fields without inventing a cost", () => {
    const result = mapOpenCodeV2Messages(
      messages(
        { type: "user", text: "hello" },
        {
          type: "user",
          text: "attachment",
          files: [{ mime: "text/plain", data: "eA==", source: { type: "inline" } }],
        },
        {
          type: "assistant",
          content: [],
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "failed",
              name: "read",
              state: {
                status: "error",
                input: {},
                error: { type: "ToolError", message: "failed" },
              },
            },
          ],
        },
        { type: "shell", shellID: "running", command: "sleep 1", status: "running" },
        { type: "shell", shellID: "timeout", command: "sleep 10", status: "timeout" },
        { type: "shell", shellID: "killed", command: "sleep 10", status: "killed" },
        { type: "model-switched", model: { providerID: "p", id: "m" } },
        { type: "location-switched", location: { directory: "/wrk_1" } },
        { type: "compaction", status: "running", reason: "auto", summary: "Partial", recent: "" }
      )
    )
    expect(result[0].content).toEqual([{ type: "text", text: "hello" }])
    expect(result[1].content[1]).toMatchObject({ resource: { uri: "data:text/plain;base64,eA==" } })
    expect(result[2].tokenUsage?.providerCost).toBeUndefined()
    expect(result[3].content[1]).toMatchObject({ content: { error: { message: "failed" } } })
    expect(result[4].content).toEqual([
      expect.objectContaining({ type: "tool_use", status: "running" }),
    ])
    expect(result[5].content[1]).toMatchObject({ isError: true })
    expect(result[6].content[1]).toMatchObject({ isError: true })
    expect(result[7].content).toEqual([{ type: "text", text: "p/m" }])
    expect(result[8].content).toEqual([{ type: "text", text: "/wrk_1" }])
    expect(result[9].content).toEqual([{ type: "text", text: "Partial" }])
  })
})
