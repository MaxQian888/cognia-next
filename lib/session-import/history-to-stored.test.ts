import {
  historyMessagesToStored,
  historyPartToStoredPart,
  historySummaryToSessionSummary,
} from "./history-to-stored"

describe("historyPartToStoredPart", () => {
  it("maps text, reasoning and file parts to the renderer's shapes", () => {
    expect(historyPartToStoredPart({ type: "text", text: "hi" })).toEqual({
      type: "text",
      text: "hi",
      state: "done",
    })
    expect(historyPartToStoredPart({ type: "reasoning", text: "why" })).toEqual({
      type: "reasoning",
      text: "why",
      state: "done",
    })
    expect(
      historyPartToStoredPart({ type: "file", mediaType: "image/*", url: "data:x", filename: "a" })
    ).toEqual({ type: "file", mediaType: "image/*", url: "data:x", filename: "a" })
  })

  it("maps commentary to the data-commentary part", () => {
    expect(
      historyPartToStoredPart({
        type: "commentary",
        text: "Checking",
        messageId: "m",
        source: "codex",
      })
    ).toEqual({
      type: "data-commentary",
      data: { messageId: "m", text: "Checking", state: "done", source: "codex" },
    })
    expect(historyPartToStoredPart({ type: "commentary", text: "x", source: "codex" })).toEqual({
      type: "data-commentary",
      data: { text: "x", state: "done", source: "codex" },
    })
  })

  it("maps a tool's recorded state: pending, output, error and status", () => {
    expect(
      historyPartToStoredPart({ type: "tool", name: "shell", toolCallId: "c", input: { a: 1 } })
    ).toEqual({ type: "tool-shell", toolCallId: "c", state: "input-available", input: { a: 1 } })
    expect(
      historyPartToStoredPart({
        type: "tool",
        name: "shell",
        toolCallId: "c",
        input: {},
        result: { ok: true, output: "out" },
        status: "completed",
      })
    ).toEqual({
      type: "tool-shell",
      toolCallId: "c",
      state: "output-available",
      input: {},
      output: "out",
      status: "completed",
    })
    expect(
      historyPartToStoredPart({
        type: "tool",
        name: "shell",
        toolCallId: "c",
        input: {},
        result: { ok: false, errorText: "boom" },
      })
    ).toEqual({
      type: "tool-shell",
      toolCallId: "c",
      state: "output-error",
      input: {},
      errorText: "boom",
    })
  })
})

describe("historyMessagesToStored", () => {
  it("assigns positional ids under the session and maps usage and annotations to metadata", () => {
    const rows = historyMessagesToStored(
      "import:codex:s",
      [
        { role: "user", parts: [{ type: "text", text: "hi" }], createdAt: 1 },
        {
          role: "assistant",
          parts: [{ type: "text", text: "yo" }],
          createdAt: 2,
          usage: { inputTokens: 3, outputTokens: 4 },
          usageModel: "gpt-5",
        },
        {
          role: "system",
          parts: [{ type: "text", text: "relay" }],
          createdAt: 3,
          annotations: { codexAgentMessage: { author: "a" } },
        },
      ],
      "project-1"
    )
    expect(rows.map((row) => [row.id, row.sessionId, row.projectId, row.role])).toEqual([
      ["import:codex:s:m0", "import:codex:s", "project-1", "user"],
      ["import:codex:s:m1", "import:codex:s", "project-1", "assistant"],
      ["import:codex:s:m2", "import:codex:s", "project-1", "system"],
    ])
    expect(rows[0].metadata).toBeUndefined()
    expect(rows[1].metadata).toEqual({ usage: { inputTokens: 3, outputTokens: 4 }, model: "gpt-5" })
    expect(rows[2].metadata).toEqual({ codexAgentMessage: { author: "a" } })
  })
})

describe("historySummaryToSessionSummary", () => {
  it("adds the file locator and keeps optional lineage only when present", () => {
    expect(
      historySummaryToSessionSummary(
        {
          sourceId: "codex",
          originalSessionId: "s",
          title: "t",
          messageCount: 2,
          updatedAt: 9,
          cwd: "/w",
          sourceVersion: "1",
        },
        "/f.jsonl"
      )
    ).toEqual({
      ref: { sourceId: "codex", originalSessionId: "s", locator: "/f.jsonl" },
      title: "t",
      sourceId: "codex",
      messageCount: 2,
      updatedAt: 9,
      cwd: "/w",
      sourceVersion: "1",
      relationKind: undefined,
    })
    expect(
      historySummaryToSessionSummary(
        {
          sourceId: "codex",
          originalSessionId: "c",
          title: "t",
          messageCount: 1,
          updatedAt: 1,
          relationKind: "subagent",
          lifecycleStatus: "running",
          parentNativeSessionId: "p",
        },
        "/c.jsonl"
      )
    ).toMatchObject({
      relationKind: "subagent",
      lifecycleStatus: "running",
      parentNativeSessionId: "p",
    })
  })
})
