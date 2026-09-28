import { clineSessionSource } from "./cline"

describe("clineSessionSource", () => {
  it("covers current SDK sessions and legacy extension task artifacts", () => {
    expect(clineSessionSource.scanRoots("/home/u")).toEqual(
      expect.arrayContaining([
        "/home/u/.cline/sessions",
        expect.stringContaining("saoudrizwan.claude-dev"),
      ])
    )
    expect(clineSessionSource.verifiedAt).toBe("2026-08-29")
  })
})

const fs = {
  exists: async () => false,
  readDir: async () => [],
  stat: async () => ({ size: 0, isFile: true }),
  readTextFile: async () => "",
}

it("preserves ordered raw Anthropic arrays, mixed result/text blocks, errors and large nested outputs", async () => {
  const output = [
    { type: "text", text: "x".repeat(30_000) },
    { type: "image", source: { type: "base64", data: "image", media_type: "image/png" } },
  ]
  const input = {
    fs,
    home: "",
    pickedFiles: [
      {
        name: "api_conversation_history.json",
        path: "/tmp/task/api_conversation_history.json",
        content: JSON.stringify([
          { role: "user", content: "start" },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "good", name: "read", input: { path: "a" } },
              { type: "tool_use", id: "bad", name: "write", input: {} },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "good", content: output },
              {
                type: "tool_result",
                tool_use_id: "bad",
                content: [{ type: "text", text: "denied" }],
                is_error: true,
              },
              { type: "text", text: "continue" },
            ],
          },
          { role: "assistant", content: "finish" },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "missing", content: "orphan" }],
          },
        ]),
      },
    ],
  }
  const listed = await clineSessionSource.listSessions(input)
  const graph = await clineSessionSource.parseGraph!(listed[0].ref, input)
  const messages = graph.nodes[0].conversation.messages
  expect(messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "user",
    "assistant",
  ])
  expect(messages[1].parts[0]).toMatchObject({
    toolCallId: "good",
    state: "output-available",
    output,
  })
  expect(messages[1].parts[1]).toMatchObject({
    toolCallId: "bad",
    state: "output-error",
    errorText: "denied",
  })
  expect(messages[2].parts[0]).toMatchObject({ type: "text", text: "continue" })
  expect(graph.nodes[0].loss.losses).toEqual(
    expect.arrayContaining([expect.objectContaining({ path: "tools.missing" })])
  )
})

it("uses the Cline native messages filename identity and preserves ApiMessage timestamps", async () => {
  const input = {
    fs,
    home: "",
    pickedFiles: [
      {
        name: "task-42.messages.json",
        path: "/tmp/task-42/task-42.messages.json",
        content: JSON.stringify([
          { role: "user", content: "start", ts: 1700000000000 },
          { role: "assistant", content: "finish", ts: 1700000005000 },
        ]),
      },
    ],
  }
  const listed = await clineSessionSource.listSessions(input)
  expect(listed[0].ref.originalSessionId).toBe("task-42")
  const graph = await clineSessionSource.parseGraph!(listed[0].ref, input)
  expect(graph.nodes[0].conversation.messages.map((message) => message.createdAt)).toEqual([
    1700000000000, 1700000005000,
  ])
})

it("keeps portable legacy IDs and timestamp precedence with native-looking rows", async () => {
  const input = {
    fs,
    home: "",
    pickedFiles: [
      {
        name: "history.json",
        path: "/tmp/history.json",
        content: JSON.stringify({
          id: "legacy",
          messages: [{ role: "user", content: "hello", timestamp: 10, ts: 20 }],
        }),
      },
    ],
  }
  const listed = await clineSessionSource.listSessions(input)
  expect(listed[0].ref.originalSessionId).toBe("legacy")
  const graph = await clineSessionSource.parseGraph!(listed[0].ref, input)
  expect(graph.nodes[0].conversation.messages[0].createdAt).toBe(10)
})
