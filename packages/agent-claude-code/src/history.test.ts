import {
  CLAUDE_CODE_HISTORY_FORMAT,
  claudeCodeFileStem,
  claudeCodeTaskStatus,
  claudeCodeTeamSnapshot,
  claudeCodeTranscriptTasks,
  detectClaudeCodeTranscripts,
  isClaudeCodeSubagentTranscript,
  readClaudeCodeTranscript,
  summarizeClaudeCodeTranscript,
} from "./history"

const host = { redactText: (text: string) => text.replace(/sk-[a-z0-9]+/g, "[redacted]") }
const jsonl = (...rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n")
const at = (second: number) => `2026-08-01T00:00:${String(second).padStart(2, "0")}.000Z`

describe("readClaudeCodeTranscript", () => {
  it("keeps the active main thread, resolves tool results and maps usage", () => {
    const read = readClaudeCodeTranscript(
      jsonl(
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          sessionId: "s1",
          cwd: "/w",
          timestamp: at(1),
          message: { content: "Fix the bug" },
        },
        {
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          timestamp: at(2),
          costUSD: 0.2,
          durationMs: 900,
          message: {
            model: "claude-x",
            usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 2 },
            content: [
              { type: "thinking", thinking: "look" },
              { type: "tool_use", id: "t1", name: "Read", input: { path: "a" } },
              { type: "tool_use", id: "t2", name: "Bash", input: { cmd: "x" } },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AA" } },
            ],
          },
        },
        {
          type: "user",
          uuid: "u2",
          parentUuid: "a1",
          timestamp: at(3),
          toolUseResult: { stdout: "rich" },
          message: {
            content: [
              { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "body" }] },
              { type: "tool_result", tool_use_id: "t2", content: "", is_error: true },
            ],
          },
        },
        {
          type: "assistant",
          uuid: "old",
          parentUuid: "u2",
          timestamp: at(4),
          message: { content: "abandoned" },
        },
        {
          type: "assistant",
          uuid: "new",
          parentUuid: "u2",
          timestamp: at(5),
          message: { content: "kept" },
        },
        { type: "system", uuid: "sys", parentUuid: "new", timestamp: at(6), content: "hook ran" },
        { type: "summary", summary: "A summary" }
      ),
      "/p/s1.jsonl",
      host
    )
    const { session } = read
    expect(session.sourceId).toBe(CLAUDE_CODE_HISTORY_FORMAT.sourceId)
    expect(session.originalSessionId).toBe("s1")
    expect(session.title).toBe("Fix the bug")
    expect(session.model).toBe("claude-x")
    expect(session.cwd).toBe("/w")
    expect(session.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "system",
    ])
    expect(session.messages[1]).toMatchObject({
      usage: {
        inputTokens: 5,
        outputTokens: 3,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 2,
        totalCostUsd: 0.2,
        durationMs: 900,
      },
      usageModel: "claude-x",
    })
    expect(session.messages[1]!.parts).toEqual([
      { type: "reasoning", text: "look" },
      {
        type: "tool",
        name: "Read",
        toolCallId: "t1",
        input: { path: "a" },
        result: { ok: true, output: "body" },
      },
      {
        type: "tool",
        name: "Bash",
        toolCallId: "t2",
        input: { cmd: "x" },
        result: { ok: false, errorText: JSON.stringify({ stdout: "rich" }) },
      },
      { type: "file", mediaType: "image/png", url: "data:image/png;base64,AA" },
    ])
    expect(session.messages[2]!.parts).toEqual([{ type: "text", text: "kept" }])
    expect(session.messages[3]!.parts).toEqual([{ type: "text", text: "hook ran" }])
    expect(session.losses).toEqual([])
    expect(read.subagents).toEqual([])
  })

  it("reads sidechains as subagent runs on their spawning turn", () => {
    const read = readClaudeCodeTranscript(
      jsonl(
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          sessionId: "s",
          timestamp: at(1),
          message: { content: "go" },
        },
        {
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          timestamp: at(2),
          message: {
            content: [
              { type: "tool_use", id: "task", name: "Task", input: { subagent_type: "explorer" } },
            ],
          },
        },
        {
          type: "user",
          uuid: "sc1",
          parentUuid: "a1",
          isSidechain: true,
          timestamp: at(3),
          message: { content: "inner ask" },
        },
        {
          type: "assistant",
          uuid: "sc2",
          parentUuid: "sc1",
          isSidechain: true,
          timestamp: at(4),
          message: { content: "inner answer" },
        },
        {
          type: "user",
          uuid: "orphan",
          isSidechain: true,
          timestamp: at(5),
          message: { content: [{ type: "tool_result" }] },
        }
      ),
      "s.jsonl",
      host
    )
    expect(read.sidechains.map((group) => group.rootUuid)).toEqual(["sc1", "orphan"])
    expect(read.subagents).toEqual([
      {
        subagentId: "sc1",
        spawnParentUuid: "a1",
        hostMessageIndex: 1,
        name: "explorer",
        title: "inner ask",
        messages: [
          {
            role: "user",
            parts: [{ type: "text", text: "inner ask" }],
            createdAt: Date.parse(at(3)),
          },
          {
            role: "assistant",
            parts: [{ type: "text", text: "inner answer" }],
            createdAt: Date.parse(at(4)),
          },
        ],
        startedAt: Date.parse(at(3)),
        completedAt: Date.parse(at(4)),
      },
    ])
    expect(read.session.messages.map((message) => message.parts[0]?.type)).toEqual(["text", "tool"])
  })

  it("keeps unknown records as redacted diagnostics and reports unparseable lines", () => {
    const read = readClaudeCodeTranscript(
      [
        JSON.stringify({ type: "file-history-snapshot", timestamp: at(1), key: "sk-abc123" }),
        "{broken",
        JSON.stringify({ type: "user", agentId: "agent-7", message: { content: "hi" } }),
      ].join("\n"),
      "fallback",
      host
    )
    expect(read.agentId).toBe("agent-7")
    expect(read.session.originalSessionId).toBe("agent-7")
    expect(read.session.recordedEvents).toHaveLength(1)
    const payload = read.session.recordedEvents[0]!.event as {
      payload: { type: string; summary: string }
    }
    expect(payload.payload.type).toBe("file-history-snapshot")
    expect(payload.payload.summary).toContain("[redacted]")
    expect(payload.payload.summary).not.toContain("sk-abc123")
    expect(read.session.losses.map((loss) => [loss.path, loss.kind])).toEqual([
      ["jsonl[1]", "dropped"],
      ["records[0].file-history-snapshot", "approximated"],
    ])
  })
})

describe("claudeCodeTranscriptTasks", () => {
  it("merges Task tool calls per task id, latest call winning", () => {
    const tasks = claudeCodeTranscriptTasks([
      {
        role: "assistant",
        createdAt: 1,
        parts: [
          {
            type: "tool",
            name: "TaskCreate",
            toolCallId: "c1",
            input: { taskId: "t1", subject: "Lint", run_in_background: true },
          },
          {
            type: "tool",
            name: "TaskUpdate",
            toolCallId: "c2",
            input: { taskId: "t1", status: "done", blockedBy: ["t0", 3] },
          },
          {
            type: "tool",
            name: "Task",
            toolCallId: "c3",
            input: { description: "Explore" },
            result: { ok: false, errorText: "x" },
          },
          { type: "tool", name: "Read", toolCallId: "c4", input: {} },
        ],
      },
    ])
    expect(tasks).toEqual([
      {
        taskId: "t1",
        description: "Lint",
        summary: undefined,
        status: "completed",
        background: true,
        toolCallId: "c2",
        parentTaskId: undefined,
        dependencies: ["t0"],
      },
      {
        taskId: "c3",
        description: "Explore",
        summary: undefined,
        status: "failed",
        toolCallId: "c3",
        parentTaskId: undefined,
        dependencies: undefined,
      },
    ])
  })

  it("maps status words onto canonical lifecycle states", () => {
    expect(
      ["DONE", "error", "canceled", "pending", "blocked", "whatever", 7].map(claudeCodeTaskStatus)
    ).toEqual(["completed", "failed", "cancelled", "pending", "waiting", "running", "running"])
  })
})

describe("claudeCodeTeamSnapshot", () => {
  const corpus = {
    configs: [
      {
        path: "/h/.claude/teams/alpha/config.json",
        value: { leadSessionId: "lead", members: [{ name: "bob", agentId: "b1" }, "junk"] },
      },
      {
        path: "/h/.claude/teams/beta/config.json",
        value: { name: "beta", cwd: "/other", members: [] },
      },
    ],
    taskFiles: [
      {
        path: "/h/.claude/tasks/alpha/7.json",
        value: { subject: "Fix", owner: "bob", status: "in_progress", blockedBy: ["6"] },
      },
      { path: "/h/.claude/tasks/beta/1.json", value: { id: "x" } },
    ],
  }

  it("finds the team a session leads and its task files", () => {
    const snapshot = claudeCodeTeamSnapshot(corpus, "lead")
    expect(snapshot.members).toEqual([{ name: "bob", agentId: "b1" }])
    expect(snapshot.tasks).toEqual([
      {
        taskId: "7",
        description: "Fix",
        summary: undefined,
        status: "running",
        background: undefined,
        parentTaskId: undefined,
        dependencies: ["6"],
      },
    ])
    expect([...snapshot.taskOwnerById]).toEqual([["7", "bob"]])
  })

  it("matches by cwd or member session and is empty otherwise", () => {
    expect(
      claudeCodeTeamSnapshot(corpus, "nobody", "/other").tasks.map((task) => task.taskId)
    ).toEqual(["x"])
    expect(claudeCodeTeamSnapshot(corpus, "nobody")).toEqual({
      members: [],
      tasks: [],
      taskOwnerById: new Map(),
    })
  })
})

describe("summaries and detection", () => {
  it("summarizes without resolving the DAG and marks independent subagent files", () => {
    const content = jsonl(
      {
        type: "user",
        sessionId: "s9",
        cwd: "/w",
        timestamp: at(2),
        message: {
          content: [
            { type: "text", text: " " },
            { type: "text", text: "Ask" },
          ],
        },
      },
      { type: "assistant", timestamp: at(8), message: { content: "Answer" } },
      "garbage"
    )
    expect(summarizeClaudeCodeTranscript(content, "/p/s9.jsonl")).toEqual({
      sourceId: "claude-code",
      originalSessionId: "s9",
      title: "Ask",
      messageCount: 2,
      updatedAt: Date.parse(at(8)),
      cwd: "/w",
      relationKind: undefined,
      sourceVersion: CLAUDE_CODE_HISTORY_FORMAT.verifiedVersion,
    })
    expect(summarizeClaudeCodeTranscript(content, "/p/s9/subagents/agent-3.jsonl")).toMatchObject({
      originalSessionId: "agent-3",
      relationKind: "subagent",
    })
    expect(summarizeClaudeCodeTranscript(jsonl({ type: "summary", summary: "x" }), "x")).toBeNull()
    expect(isClaudeCodeSubagentTranscript("C:\\p\\s\\subagents\\a.jsonl")).toBe(true)
    expect(claudeCodeFileStem("C:\\p\\a.JSONL")).toBe("a")
  })

  it("detects transcripts by path or by the first record's shape", () => {
    const file = (path: string, content = "") => ({ path, name: path, content })
    expect(detectClaudeCodeTranscripts([])).toBe("no")
    expect(detectClaudeCodeTranscripts([file("/h/.claude/projects/a.jsonl")])).toBe("match")
    expect(
      detectClaudeCodeTranscripts([file("/h/.claude/projects/a.jsonl"), file("/x.jsonl")])
    ).toBe("maybe")
    expect(
      detectClaudeCodeTranscripts([
        file("/x.jsonl", `\n${JSON.stringify({ parentUuid: null, message: {} })}`),
      ])
    ).toBe("maybe")
    expect(
      detectClaudeCodeTranscripts([file("/x.jsonl", JSON.stringify({ parentUuid: null }))])
    ).toBe("no")
    expect(detectClaudeCodeTranscripts([file("/x.jsonl", "nope")])).toBe("no")
  })
})
