import {
  detectOpencodeExport,
  OPENCODE_HISTORY_FORMAT,
  opencodeSessionRevision,
  opencodeSessionTree,
  parseOpencodeExport,
  readOpencodeSession,
  type OpencodeSession,
} from "./history"

function session(overrides: Partial<OpencodeSession> = {}): OpencodeSession {
  return {
    id: "ses_1",
    title: "",
    cwd: "/w",
    createdAt: 1_000,
    updatedAt: 2_000,
    messages: [],
    ...overrides,
  }
}

describe("readOpencodeSession", () => {
  it("maps every part kind and keeps each loss once", () => {
    const parsed = readOpencodeSession(
      session({
        messages: [
          {
            role: "user",
            createdAt: 1_100,
            parts: [
              { type: "text", text: "Fix the build" },
              {
                type: "file",
                mime: "image/png",
                url: "data:image/png;base64,AA",
                filename: "a.png",
              },
              { type: "file", mediaType: "text/plain", url: "file:///w/b.txt" },
              { type: "file" },
            ],
          },
          {
            role: "assistant",
            createdAt: 1_200,
            model: "deepseek-chat",
            cost: 0.25,
            tokens: { input: 10, output: 5, reasoning: 2, cacheRead: 3, cacheWrite: 4 },
            parts: [
              { type: "reasoning", text: "thinking" },
              {
                type: "tool",
                tool: "bash",
                callID: "c1",
                state: { status: "completed", input: { cmd: "ls" }, output: "ok" },
              },
              {
                type: "tool",
                tool: "edit",
                callID: "c2",
                state: { status: "error", error: "denied" },
              },
              { type: "tool", tool: "read", callID: "c3", state: { status: "error" } },
              { type: "tool-invocation", callID: "c4", state: { input: { q: 1 } } },
              { type: "patch", text: "src/a.ts" },
              { type: "patch" },
              { type: "snapshot", filename: "snap" },
              { type: "agent", name: "explore" },
              { type: "retry" },
              { type: "compaction", text: "summary" },
              { type: "step-start" },
              { type: "step-finish" },
              { type: "mystery" },
              { type: "text", text: "" },
            ],
          },
          { role: "user", createdAt: 1_300, parts: [{ type: "step-boundary" }] },
        ],
      })
    )

    expect(parsed.title).toBe("Fix the build")
    expect(parsed.messages).toHaveLength(2)
    expect(parsed.messages[0]).toEqual({
      role: "user",
      createdAt: 1_100,
      parts: [
        { type: "text", text: "Fix the build" },
        {
          type: "file",
          mediaType: "image/png",
          url: "data:image/png;base64,AA",
          filename: "a.png",
        },
        { type: "file", mediaType: "text/plain", url: "file:///w/b.txt" },
      ],
    })
    const assistant = parsed.messages[1]!
    expect(assistant.usage).toEqual({
      inputTokens: 10,
      outputTokens: 7,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 4,
      totalCostUsd: 0.25,
    })
    expect(assistant.usageModel).toBe("deepseek-chat")
    expect(assistant.parts).toEqual([
      { type: "reasoning", text: "thinking" },
      {
        type: "tool",
        name: "bash",
        toolCallId: "c1",
        input: { cmd: "ls" },
        result: { ok: true, output: "ok" },
      },
      {
        type: "tool",
        name: "edit",
        toolCallId: "c2",
        input: {},
        result: { ok: false, errorText: "denied" },
      },
      { type: "tool", name: "read", toolCallId: "c3", input: {} },
      { type: "tool", name: "tool", toolCallId: "c4", input: { q: 1 } },
      { type: "text", text: "[patch applied: src/a.ts]" },
      { type: "text", text: "[patch applied]" },
      { type: "text", text: "[snapshot: snap]" },
      { type: "text", text: "[delegated to agent: explore]" },
      { type: "text", text: "[retry]" },
      { type: "text", text: "[context compacted: summary]" },
      { type: "text", text: "[step started]" },
      { type: "text", text: "[step finished]" },
    ])
    expect(parsed.losses.map((loss) => [loss.path, loss.kind])).toEqual([
      ["parts.file", "dropped"],
      ["parts.tool.error", "approximated"],
      ["parts.patch", "summarized"],
      ["parts.snapshot", "summarized"],
      ["parts.mystery", "dropped"],
      ["parts.step-boundary", "dropped"],
    ])
  })

  it("records no usage for user turns or turns with nothing recorded", () => {
    const parsed = readOpencodeSession(
      session({
        title: "Named",
        messages: [
          {
            role: "user",
            createdAt: 1,
            tokens: { input: 9 },
            parts: [{ type: "text", text: "q" }],
          },
          { role: "assistant", createdAt: 2, tokens: {}, parts: [{ type: "text", text: "a" }] },
          { role: "system", createdAt: 3, cost: 0, parts: [{ type: "text", text: "s" }] },
          { role: "assistant", createdAt: 4, cost: 0, parts: [{ type: "text", text: "free" }] },
        ],
      })
    )
    expect(parsed.title).toBe("Named")
    expect(parsed.messages.map((message) => [message.role, message.usage])).toEqual([
      ["user", undefined],
      ["assistant", undefined],
      ["system", undefined],
      [
        "assistant",
        {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          totalCostUsd: 0,
        },
      ],
    ])
    expect(parsed.losses).toEqual([])
  })

  it("falls back to a default title and marks a child session as a subagent", () => {
    const parsed = readOpencodeSession(session({ id: "child", parentId: "parent" }))
    expect(parsed.title).toBe("OpenCode session")
    expect(parsed.relationKind).toBe("subagent")
    expect(parsed.parentNativeSessionId).toBe("parent")
    expect(parsed.sourceId).toBe(OPENCODE_HISTORY_FORMAT.sourceId)
    expect(readOpencodeSession(session()).relationKind).toBeUndefined()
  })

  it("keeps background jobs, compactions and structural markers as structured state", () => {
    const parsed = readOpencodeSession(
      session({
        jobs: [
          { id: "j1", status: "done", description: "lint", createdAt: 1_000, updatedAt: 2_000 },
          { id: "j2", status: "blocked", parentId: "j1", dependencies: ["j1"], updatedAt: 3_000 },
          { id: "j3", status: "canceled", error: "stopped" },
        ],
        messages: [
          {
            role: "assistant",
            createdAt: 5,
            parts: [
              { type: "compaction", id: "cmp", text: "short" },
              { type: "compaction" },
              { type: "step-start", id: "s1" },
              { type: "patch", text: "x".repeat(2_500), filename: "a.ts" },
            ],
          },
        ],
      })
    )
    expect(parsed.tasks).toEqual([
      {
        taskId: "j1",
        description: "lint",
        status: "completed",
        background: true,
        parentTaskId: undefined,
        dependencies: undefined,
        error: undefined,
        startedAt: new Date(1_000).toISOString(),
        endedAt: new Date(2_000).toISOString(),
      },
      {
        taskId: "j2",
        description: undefined,
        status: "waiting",
        background: true,
        parentTaskId: "j1",
        dependencies: ["j1"],
        error: undefined,
        startedAt: undefined,
        endedAt: undefined,
      },
      {
        taskId: "j3",
        description: undefined,
        status: "cancelled",
        background: true,
        parentTaskId: undefined,
        dependencies: undefined,
        error: "stopped",
        startedAt: undefined,
        endedAt: undefined,
      },
    ])
    expect(parsed.history).toEqual([
      { historyId: "cmp", kind: "compaction", summary: "short" },
      { historyId: "compaction-2", kind: "compaction", summary: undefined },
    ])
    expect(parsed.recordedEvents).toEqual([
      {
        eventId: "s1",
        sequence: 0,
        event: { kind: "diagnostic", runtime: "opencode", payload: { type: "step-start" } },
      },
      {
        eventId: "opencode-event-1",
        sequence: 1,
        event: {
          kind: "diagnostic",
          runtime: "opencode",
          payload: { type: "patch", text: "x".repeat(2_000), filename: "a.ts" },
        },
      },
    ])
  })
})

describe("parseOpencodeExport", () => {
  it("rebuilds sessions from flat share records, grouping parts under their message", () => {
    const sessions = parseOpencodeExport(
      JSON.stringify([
        {
          key: "session/info/ses_a",
          content: {
            id: "ses_a",
            title: "Shared",
            directory: "/r",
            time: { created: 1, updated: 9 },
          },
        },
        {
          key: "message/ses_a/msg_1",
          content: {
            id: "msg_1",
            sessionID: "ses_a",
            role: "assistant",
            time: { created: 5 },
            modelID: "m1",
            cost: 0.1,
            tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
          },
        },
        { key: "part/ses_a/msg_1/p1", content: { messageID: "msg_1", type: "text", text: "hi" } },
        {
          key: "message/ses_x/orphan",
          content: { id: "orphan", sessionID: "missing", role: "user" },
        },
        "not a record",
      ])
    )
    expect(sessions).toEqual([
      {
        id: "ses_a",
        title: "Shared",
        cwd: "/r",
        parentId: undefined,
        createdAt: 1,
        updatedAt: 9,
        messages: [
          {
            id: "msg_1",
            sessionID: "ses_a",
            role: "assistant",
            parts: [{ messageID: "msg_1", type: "text", text: "hi" }],
            createdAt: 5,
            sort: 0,
            model: "m1",
            cost: 0.1,
            tokens: { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 },
          },
        ],
      },
    ])
  })

  it("reads ShareNext records and skips their non-transcript records", () => {
    const sessions = parseOpencodeExport(
      JSON.stringify([
        { type: "session", data: { id: "s", title: "Next", parentID: "p", time: { created: 2 } } },
        { type: "message", data: { id: "m", sessionID: "s", role: "user", time: { created: 3 } } },
        { type: "part", data: { messageID: "m", type: "text", text: "yo" } },
        { type: "session_diff", data: { id: "ignored", title: "x", time: {} } },
      ])
    )
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ id: "s", parentId: "p", createdAt: 2, updatedAt: 2 })
    expect(sessions[0]!.messages[0]!.parts).toEqual([{ messageID: "m", type: "text", text: "yo" }])
  })

  it("reads the nested CLI export with its background jobs", () => {
    const [nested] = parseOpencodeExport(
      JSON.stringify({
        info: { id: "n", title: "Nested", directory: "/n", time: { created: 4, updated: 6 } },
        messages: [
          {
            info: { role: "assistant", time: { created: 5 }, model: "m2" },
            parts: [{ type: "text", text: "a" }, 7],
          },
          "skip",
        ],
        jobs: [
          { id: "j", status: "running", description: "d", parentID: "q", dependencies: ["q", 3] },
          null,
        ],
      })
    )
    expect(nested).toEqual({
      id: "n",
      title: "Nested",
      cwd: "/n",
      parentId: undefined,
      createdAt: 4,
      updatedAt: 6,
      messages: [
        { role: "assistant", parts: [{ type: "text", text: "a" }], createdAt: 5, model: "m2" },
      ],
      jobs: [
        {
          id: "j",
          status: "running",
          description: "d",
          parentId: "q",
          dependencies: ["q"],
          error: undefined,
        },
      ],
    })
  })

  it("yields nothing for content that is not an export", () => {
    expect(parseOpencodeExport("{not json")).toEqual([])
    expect(parseOpencodeExport(JSON.stringify({ title: "x" }))).toEqual([])
    expect(parseOpencodeExport(JSON.stringify({ messages: [], info: { title: "no id" } }))).toEqual(
      []
    )
  })
})

describe("detectOpencodeExport", () => {
  const file = (path: string, content: string) => ({ path, name: path, content })
  it("recognizes exports by path or by record shape", () => {
    expect(detectOpencodeExport([])).toBe("no")
    expect(detectOpencodeExport([file("/tmp/opencode-export.json", "{}")])).toBe("maybe")
    expect(detectOpencodeExport([file("/a.json", '[{"key":"session/x"}]')])).toBe("maybe")
    expect(detectOpencodeExport([file("/a.json", '[{"type":"part","data":{}}]')])).toBe("maybe")
    expect(detectOpencodeExport([file("/a.json", '{"id":"s","messages":[]}')])).toBe("maybe")
    expect(detectOpencodeExport([file("/a.json", '[{"type":"part","data":1}]')])).toBe("no")
    expect(detectOpencodeExport([file("/a.json", "not json")])).toBe("no")
  })
})

describe("opencodeSessionTree", () => {
  const text = [{ role: "user", createdAt: 1, parts: [{ type: "text", text: "x" }] }]
  it("offers roots with their transitive subagents and skips empty sessions", () => {
    const tree = opencodeSessionTree([
      session({ id: "root", messages: text }),
      session({ id: "child", parentId: "root", messages: text }),
      session({ id: "grandchild", parentId: "child", messages: text }),
      session({ id: "orphan", parentId: "gone", messages: text }),
      session({ id: "empty", parentId: "root" }),
    ])
    expect(tree.roots.map((root) => root.id)).toEqual(["root", "orphan"])
    expect(tree.descendantsOf("root").map((child) => child.id)).toEqual(["child", "grandchild"])
    expect(tree.descendantsOf("orphan")).toEqual([])
  })

  it("keeps one representative of a cyclic component", () => {
    const tree = opencodeSessionTree([
      session({ id: "a", parentId: "b", messages: text }),
      session({ id: "b", parentId: "a", messages: text }),
    ])
    expect(tree.roots.map((root) => root.id)).toEqual(["a"])
    expect(tree.descendantsOf("a").map((child) => child.id)).toEqual(["b"])
  })
})

describe("opencodeSessionRevision", () => {
  it("is stable for equal content, order-independent for descendants, and moves on change", () => {
    const root = session({ id: "r" })
    const a = session({ id: "a" })
    const b = session({ id: "b" })
    const revision = opencodeSessionRevision(root, [a, b])
    expect(revision).toMatch(/^opencode:\d+:[0-9a-z]+$/)
    expect(opencodeSessionRevision(root, [b, a])).toBe(revision)
    expect(opencodeSessionRevision({ ...root, title: "changed" }, [a, b])).not.toBe(revision)
  })
})
