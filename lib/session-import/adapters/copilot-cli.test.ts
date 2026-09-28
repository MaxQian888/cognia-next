import { copilotCliSessionSource } from "./copilot-cli"

describe("copilotCliSessionSource", () => {
  it("scans the documented local session-state directory", () => {
    expect(copilotCliSessionSource.scanRoots("/home/u")).toEqual(["/home/u/.copilot/session-state"])
    expect(copilotCliSessionSource.detect([])).toBe("no")
  })
})

const fs = {
  exists: async () => false,
  readDir: async () => [],
  stat: async () => ({ size: 0, isFile: true }),
  readTextFile: async () => "",
}

it("projects persisted SDK messages and complete tools without duplicating ephemeral chunks", async () => {
  const event = (type: string, data: unknown, extra = {}) => ({
    type,
    data,
    id: type,
    timestamp: "2026-09-01T00:00:00Z",
    ...extra,
  })
  const output = {
    content: "ok",
    detailedContent: "x".repeat(25_000),
    contents: [{ type: "text", text: "structured" }],
  }
  const events = [
    event("session.start", { sessionId: "sdk", context: { cwd: "/repo" } }),
    event("user.message", { content: "start" }),
    event("assistant.message_delta", { deltaContent: "do not duplicate" }, { ephemeral: true }),
    event("assistant.message", {
      content: "working",
      reasoningText: "reason",
      toolRequests: [
        { toolCallId: "good", name: "shell", arguments: { command: "pwd" } },
        { toolCallId: "bad", name: "write", arguments: {} },
      ],
    }),
    event("tool.execution_start", { toolCallId: "good", toolName: "shell" }),
    event("tool.execution_complete", { toolCallId: "good", success: true, result: output }),
    event("tool.execution_complete", {
      toolCallId: "bad",
      success: false,
      error: { message: "denied", code: "EPERM" },
    }),
    event("assistant.reasoning", { content: "next thought" }),
  ]
  const input = {
    fs,
    home: "",
    pickedFiles: [
      {
        name: "events.jsonl",
        path: "/tmp/sdk/events.jsonl",
        content: events.map((item) => JSON.stringify(item)).join("\n"),
      },
    ],
  }
  const listed = await copilotCliSessionSource.listSessions(input)
  expect(listed[0]).toMatchObject({ cwd: "/repo", ref: { originalSessionId: "sdk" } })
  const graph = await copilotCliSessionSource.parseGraph!(listed[0].ref, input)
  const messages = graph.nodes[0].conversation.messages
  expect(messages).toHaveLength(3)
  expect(messages[1].parts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "reasoning", text: "reason" }),
      expect.objectContaining({ toolCallId: "good", input: { command: "pwd" }, output }),
      expect.objectContaining({
        toolCallId: "bad",
        state: "output-error",
        errorText: '{"message":"denied","code":"EPERM"}',
      }),
    ])
  )
  expect(messages[2].parts[0]).toMatchObject({ type: "reasoning", text: "next thought" })
  expect(JSON.stringify(messages)).not.toContain("do not duplicate")
  expect(graph.nodes[0].loss.losses).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: "events.copilot.assistant.message_delta" }),
    ])
  )
})

it("keeps subagent events out of the parent transcript and uses read-only synthetic child bindings", async () => {
  const records = [
    { id: "u", type: "user.message", data: { content: "root" }, timestamp: "2026-09-01T00:00:00Z" },
    {
      id: "a",
      type: "assistant.message",
      agentId: "worker",
      data: { content: "child" },
      timestamp: "2026-09-01T00:00:01Z",
    },
  ]
  const input = {
    fs,
    home: "",
    pickedFiles: [
      {
        name: "events.jsonl",
        path: "/tmp/session/events.jsonl",
        content: records.map((item) => JSON.stringify(item)).join("\n"),
      },
    ],
  }
  const listed = await copilotCliSessionSource.listSessions(input)
  expect(listed).toHaveLength(1)
  const graph = await copilotCliSessionSource.parseGraph!(listed[0].ref, input)
  expect(graph.nodes).toHaveLength(2)
  expect(graph.nodes[0].conversation.messages).toHaveLength(1)
  expect(graph.nodes[1].conversation.messages[0].parts[0]).toMatchObject({ text: "child" })
  expect(graph.nodes[1].conversation.session.importRuntimeBinding).toBeUndefined()
  expect(graph.nodes[1].session.header.lineage?.kind).toBe("subagent")
})

it.each(["id", "session_id", "conversationId"])(
  "preserves legacy %s instead of replacing it with the filename",
  async (key) => {
    const input = {
      fs,
      home: "",
      pickedFiles: [
        {
          name: "history.json",
          path: "/tmp/history.json",
          content: JSON.stringify({
            [key]: "legacy",
            messages: [{ role: "user", content: "hello" }],
          }),
        },
      ],
    }
    const listed = await copilotCliSessionSource.listSessions(input)
    expect(listed[0].ref.originalSessionId).toBe("legacy")
  }
)
