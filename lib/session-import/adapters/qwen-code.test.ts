import { qwenCodeSessionSource } from "./qwen-code"

describe("qwenCodeSessionSource", () => {
  it("accepts official JSON/JSONL exports and local session artifacts", () => {
    expect(qwenCodeSessionSource.acceptedExtensions).toEqual([".json", ".jsonl"])
    expect(qwenCodeSessionSource.scanRoots("/home/u")).toEqual([
      "/home/u/.qwen/sessions",
      "/home/u/.qwen/tmp",
      "/home/u/.qwen/projects",
    ])
    expect(qwenCodeSessionSource.parseGraph).toEqual(expect.any(Function))
  })
})

const fs = {
  exists: async () => false,
  readDir: async () => [],
  stat: async () => ({ size: 0, isFile: true }),
  readTextFile: async () => "",
}

const native = (
  uuid: string,
  parentUuid: string | null,
  type: string,
  parts: unknown[],
  extra = {}
) => ({
  uuid,
  parentUuid,
  sessionId: "native",
  timestamp: "2026-09-01T00:00:00Z",
  type,
  cwd: "/repo",
  message: { role: type === "assistant" ? "model" : "user", parts },
  ...extra,
})
async function graphFor(records: unknown[], tail = "") {
  const input = {
    fs,
    home: "",
    pickedFiles: [
      {
        name: "native.jsonl",
        path: "/tmp/native.jsonl",
        content: records.map((record) => JSON.stringify(record)).join("\n") + tail,
      },
    ],
  }
  const listed = await qwenCodeSessionSource.listSessions(input)
  expect(listed).toHaveLength(1)
  return qwenCodeSessionSource.parseGraph!(listed[0].ref, input)
}

describe("Qwen native ChatRecord transcripts", () => {
  it("reads nested Content, fragments, reasoning, binary attachments and complete tool responses", async () => {
    const output = { result: "x".repeat(20_000), details: { full: true } }
    const graph = await graphFor(
      [
        native("u", null, "user", [
          { text: "hello" },
          { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } },
        ]),
        native("a", "u", "assistant", [{ text: "thinking", thought: true }]),
        native(
          "a",
          "u",
          "assistant",
          [{ functionCall: { id: "call", name: "read", args: { path: "a" } } }],
          { usageMetadata: { totalTokenCount: 7 } }
        ),
        native("r", "a", "tool_result", [
          { functionResponse: { id: "call", name: "read", response: output } },
        ]),
        native("end", "r", "assistant", [{ text: "done" }]),
      ],
      '\n{"uuid":'
    )
    const node = graph.nodes[0]
    expect(node.conversation.messages).toHaveLength(3)
    expect(node.conversation.messages[0].parts[1]).toMatchObject({
      type: "file",
      mediaType: "image/png",
      url: "data:image/png;base64,aGVsbG8=",
    })
    expect(node.conversation.messages[1].parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "reasoning", text: "thinking" }),
        expect.objectContaining({
          type: "tool-read",
          toolCallId: "call",
          output,
          state: "output-available",
        }),
      ])
    )
    expect(node.conversation.messages[1].metadata).toMatchObject({ usage: { totalTokenCount: 7 } })
    expect(node.loss.losses).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "jsonl" })])
    )
  })

  it("uses physical leaf order, preserves inactive branches, and does not offer synthetic native resume", async () => {
    const graph = await graphFor([
      native("u", null, "user", [{ text: "root" }]),
      native("old", "u", "assistant", [{ text: "old branch" }], {
        timestamp: "2026-09-25T00:00:00Z",
      }),
      native("rewind", "u", "system", [], {
        subtype: "rewind",
        systemPayload: { reason: "retry" },
      }),
      native("new", "rewind", "assistant", [{ text: "active" }]),
      native("artifact", "new", "system", [], {
        subtype: "session_artifact_event",
        systemPayload: { path: "artifact" },
      }),
    ])
    expect(graph.nodes).toHaveLength(2)
    expect(JSON.stringify(graph.nodes[0].conversation.messages)).not.toContain("old branch")
    expect(JSON.stringify(graph.nodes[0].conversation.messages)).toContain("active")
    expect(JSON.stringify(graph.nodes[1].conversation.messages)).toContain("old branch")
    expect(graph.nodes[1].conversation.session.importRuntimeBinding).toBeUndefined()
    expect(graph.nodes[0].session.history?.[0].kind).toBe("rewind")
  })

  it("stops at missing parents and reports cycles without resurrecting discarded history", async () => {
    const graph = await graphFor([
      native("old", null, "user", [{ text: "discarded" }]),
      native("tail", "missing", "assistant", [{ text: "reachable" }]),
    ])
    expect(JSON.stringify(graph.nodes[0].conversation.messages)).not.toContain("discarded")
    expect(graph.nodes[0].loss.losses).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "events.qwen.history_gap" })])
    )
    const cyclic = await graphFor([
      native("a", "b", "user", [{ text: "a" }]),
      native("b", "a", "assistant", [{ text: "b" }]),
    ])
    expect(cyclic.nodes[0].conversation.messages).toHaveLength(2)
    expect(cyclic.nodes[0].loss.losses).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "events.qwen.parent_cycle" })])
    )
  })
})

it("retains native parent-session lineage and latest title metadata", async () => {
  const records = [
    native("u", null, "user", [{ text: "hello" }]),
    native("parent", "u", "system", [], {
      subtype: "parent_session",
      systemPayload: { parentSessionId: "creator" },
    }),
    native("display", "parent", "system", [], {
      subtype: "user_text_elements",
      systemPayload: { elements: ["source"] },
    }),
    native("title", "display", "system", [], {
      subtype: "custom_title",
      systemPayload: { customTitle: "Named task" },
    }),
  ]
  const graph = await graphFor(records)
  expect(graph.nodes[0].conversation.session.title).toBe("Named task")
  expect(graph.nodes[0].loss.losses).toEqual(
    expect.arrayContaining([expect.objectContaining({ path: "events.qwen.user_text_elements" })])
  )
  expect(graph.nodes[0].conversation.session.importRelation).toMatchObject({
    kind: "subagent",
    parentNativeSessionId: "creator",
  })
})

it("detects off-root native ChatRecords structurally and imports a single-record JSON file", async () => {
  const content = JSON.stringify(native("only", null, "user", [{ text: "standalone" }]))
  const file = { name: "export.json", path: "/Downloads/export.json", content }
  expect(qwenCodeSessionSource.detect([file])).toBe("match")
  expect(
    qwenCodeSessionSource.detect([
      {
        ...file,
        content: JSON.stringify({
          uuid: "claude",
          parentUuid: null,
          message: { role: "user", content: "hello" },
        }),
      },
    ])
  ).toBe("no")
  const input = { fs, home: "", pickedFiles: [file] }
  const listed = await qwenCodeSessionSource.listSessions(input)
  expect(listed[0].messageCount).toBe(1)
})
