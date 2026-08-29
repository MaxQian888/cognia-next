import { codexSessionSource, parseCodexRollout, summarizeCodexFile } from "./codex"
import type { SessionScanInput } from "../types"

const LINES = [
  {
    timestamp: "2025-01-03T12:00:00Z",
    type: "session_meta",
    payload: { id: "cx-1", cwd: "/work", model: "gpt-5", source: "cli" },
  },
  {
    timestamp: "2025-01-03T12:00:01Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "fix the bug" }],
    },
  },
  {
    timestamp: "2025-01-03T12:00:02Z",
    type: "response_item",
    payload: { type: "reasoning", summary: "thinking about it" },
  },
  {
    timestamp: "2025-01-03T12:00:03Z",
    type: "response_item",
    payload: { type: "function_call", name: "shell", arguments: '{"cmd":"ls"}', call_id: "c1" },
  },
  {
    timestamp: "2025-01-03T12:00:04Z",
    type: "response_item",
    payload: { type: "function_call_output", call_id: "c1", output: "a.txt\nb.txt" },
  },
  {
    timestamp: "2025-01-03T12:00:05Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "done" }],
    },
  },
  { timestamp: "2025-01-03T12:00:06Z", type: "response_item", payload: { type: "ghost_snapshot" } },
]

const CONTENT = LINES.map((l) => JSON.stringify(l)).join("\n")

describe("parseCodexRollout", () => {
  it("reconstructs messages, reasoning, and tool calls with outputs", () => {
    const parsed = parseCodexRollout(CONTENT, "rollout.jsonl")
    expect(parsed.originalSessionId).toBe("cx-1")
    expect(parsed.cwd).toBe("/work")
    expect(parsed.model).toBe("gpt-5")
    expect(parsed.title).toBe("fix the bug")
    // user, reasoning, tool, assistant — ghost_snapshot filtered.
    expect(parsed.messages).toHaveLength(4)

    const types = parsed.messages.map((m) => (m.parts[0] as Record<string, unknown>).type)
    expect(types).toEqual(["text", "reasoning", "tool-shell", "text"])

    const tool = parsed.messages[2].parts[0] as Record<string, unknown>
    expect(tool.state).toBe("output-available")
    expect(tool.output).toBe("a.txt\nb.txt")
    expect(tool.input).toEqual({ cmd: "ls" })
  })

  it("preserves assistant commentary phase as commentary instead of final text", () => {
    const lines = [
      {
        type: "response_item",
        payload: {
          id: "commentary-1",
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "Checking the repository" }],
        },
      },
      {
        type: "response_item",
        payload: {
          id: "answer-1",
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Done" }],
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n")

    const parsed = parseCodexRollout(lines, "r.jsonl")
    expect(parsed.messages).toHaveLength(2)
    expect(parsed.messages[0].parts[0]).toEqual({
      type: "data-commentary",
      data: {
        messageId: "commentary-1",
        text: "Checking the repository",
        state: "done",
        source: "codex",
      },
    })
    expect(parsed.messages[1].parts[0]).toMatchObject({ type: "text", text: "Done" })
  })

  it("marks a failed tool result as an error (non-zero exit_code)", () => {
    const lines = [
      {
        type: "response_item",
        payload: { type: "function_call", name: "shell", arguments: "{}", call_id: "c1" },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "c1",
          output: { output: "nope", metadata: { exit_code: 1 } },
        },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n")
    const parsed = parseCodexRollout(lines, "r.jsonl")
    const tool = parsed.messages[0].parts[0] as Record<string, unknown>
    expect(tool.state).toBe("output-error")
    expect(tool.errorText).toContain("nope")
  })

  it("emits a system marker for a compacted line (previously dropped)", () => {
    const lines = [
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      },
      { type: "compacted", payload: { message: "history summarized" } },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n")
    const parsed = parseCodexRollout(lines, "r.jsonl")
    const marker = parsed.messages.find((m) => m.role === "system")
    expect(marker).toBeTruthy()
    expect((marker!.parts[0] as Record<string, unknown>).text).toBe("history summarized")
  })

  it("skips corrupt lines and still parses", () => {
    const parsed = parseCodexRollout(CONTENT + "\n{oops", "r.jsonl")
    expect(parsed.messages.length).toBeGreaterThan(0)
  })

  it("attaches a token_count event's per-turn usage to the last assistant message", () => {
    const lines = [
      {
        timestamp: "2025-01-03T12:00:00Z",
        type: "session_meta",
        payload: { id: "cx", model: "gpt-5" },
      },
      {
        timestamp: "2025-01-03T12:00:01Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "done" }],
        },
      },
      {
        timestamp: "2025-01-03T12:00:02Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 80, output_tokens: 20, cached_input_tokens: 40 },
          },
        },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n")
    const parsed = parseCodexRollout(lines, "r.jsonl")
    const meta = parsed.messages[parsed.messages.length - 1].metadata as {
      usage?: Record<string, number>
      model?: string
    }
    expect(meta.usage).toMatchObject({
      inputTokens: 80,
      outputTokens: 20,
      cacheReadInputTokens: 40,
    })
    expect(meta.model).toBe("gpt-5")
  })

  it("derives per-turn deltas from cumulative total_token_usage", () => {
    const tc = (total: Record<string, number>) => ({
      timestamp: "2025-01-03T12:00:09Z",
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: total } },
    })
    const asst = (text: string) => ({
      timestamp: "2025-01-03T12:00:01Z",
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
    })
    const lines = [
      { timestamp: "2025-01-03T12:00:00Z", type: "session_meta", payload: { id: "cx" } },
      asst("one"),
      tc({ input_tokens: 100, output_tokens: 30 }),
      asst("two"),
      tc({ input_tokens: 250, output_tokens: 70 }),
    ]
      .map((l) => JSON.stringify(l))
      .join("\n")
    const parsed = parseCodexRollout(lines, "r.jsonl")
    const usages = parsed.messages
      .map((m) => (m.metadata as { usage?: Record<string, number> })?.usage)
      .filter(Boolean)
    expect(usages[0]).toMatchObject({ inputTokens: 100, outputTokens: 30 })
    // Second turn = cumulative delta (250-100, 70-30).
    expect(usages[1]).toMatchObject({ inputTokens: 150, outputTokens: 40 })
  })

  it("parses current shell, search, image, tool-search, and agent-message items", () => {
    const lines = [
      {
        type: "response_item",
        payload: {
          type: "local_shell_call",
          call_id: "shell-1",
          status: "completed",
          action: { type: "exec", command: ["pwd"], timeout_ms: 1000 },
        },
      },
      {
        type: "response_item",
        payload: {
          id: "web-1",
          type: "web_search_call",
          status: "completed",
          action: { type: "search", query: "Codex protocol" },
        },
      },
      {
        type: "response_item",
        payload: {
          id: "image-1",
          type: "image_generation_call",
          status: "completed",
          revised_prompt: "diagram",
          result: "YWJj",
        },
      },
      {
        type: "response_item",
        payload: {
          id: "search-1",
          type: "tool_search_call",
          call_id: "search-call",
          status: "completed",
          execution: "search",
          arguments: { query: "calendar" },
        },
      },
      {
        type: "response_item",
        payload: {
          type: "tool_search_output",
          call_id: "search-call",
          status: "completed",
          execution: "search",
          tools: [{ name: "calendar" }],
        },
      },
      {
        type: "response_item",
        payload: {
          id: "agent-message-1",
          type: "agent_message",
          author: "root",
          recipient: "child",
          content: [{ type: "input_text", text: "continue the research" }],
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n")

    const parsed = parseCodexRollout(lines, "current.jsonl")
    expect(parsed.messages.map((message) => message.parts[0].type)).toEqual([
      "tool-local_shell",
      "tool-web_search",
      "tool-image_generation",
      "tool-tool_search",
      "text",
    ])
    expect(parsed.interAgentMessages).toEqual([
      expect.objectContaining({
        fromSessionId: "root",
        toSessionId: "child",
        text: "continue the research",
      }),
    ])
  })
})

describe("codexSessionSource", () => {
  const fs = {
    exists: async () => false,
    readDir: async () => [],
    stat: async () => ({ size: 0, isFile: true }),
    readTextFile: async () => "",
  }

  it("advertises the sessions scan root", () => {
    expect(codexSessionSource.scanRoots("/home/u")[0]).toContain(".codex")
    expect(codexSessionSource.scanRoots("")).toEqual([])
  })

  it("prefers the resolved $CODEX_HOME root over <home>/.codex", () => {
    const roots = {
      claudeConfigDir: "",
      codexHome: "/relocated/codex",
      opencodeConfigDir: "",
      opencodeDataDir: "",
      piAgentDir: "",
      piSessionDir: "",
      geminiDir: "",
      continueDir: "",
    }
    expect(codexSessionSource.scanRoots("/home/u", roots)).toEqual(["/relocated/codex/sessions"])
    // A blank override falls back to the home-relative default.
    expect(codexSessionSource.scanRoots("/home/u", { ...roots, codexHome: "" })).toEqual([
      "/home/u/.codex/sessions",
    ])
  })

  it("detects by rollout filename and path hint", () => {
    expect(
      codexSessionSource.detect([
        { name: "rollout-x.jsonl", path: "/a/rollout-x.jsonl", content: "" },
      ])
    ).toBe("match")
    expect(
      codexSessionSource.detect([
        { name: "s.jsonl", path: "/home/.codex/sessions/2025/s.jsonl", content: "" },
      ])
    ).toBe("match")
    expect(codexSessionSource.detect([])).toBe("no")
  })

  it("lists and parses from picked files", async () => {
    const input: SessionScanInput = {
      fs,
      home: "",
      pickedFiles: [{ name: "rollout.jsonl", path: "/p/rollout.jsonl", content: CONTENT }],
    }
    const list = await codexSessionSource.listSessions(input)
    expect(list[0].cwd).toBe("/work")
    const conv = await codexSessionSource.parseSession(list[0].ref, input)
    expect(conv.session.id).toBe("import:codex:cx-1")
    expect(conv.messages).toHaveLength(4)
  })

  it("projects lineage, lifecycle, plans, rollback, compaction, and collaboration into the graph", async () => {
    const rich = [
      {
        timestamp: "2026-08-29T00:00:00Z",
        type: "session_meta",
        payload: {
          session_id: "session-child",
          id: "thread-child",
          parent_thread_id: "thread-root",
          cwd: "/work",
          cli_version: "0.150.1",
          agent_nickname: "researcher",
          agent_role: "explorer",
          source: { sub_agent: { thread_spawn: { parent_thread_id: "thread-root", depth: 1 } } },
        },
      },
      {
        timestamp: "2026-08-29T00:00:01Z",
        type: "event_msg",
        payload: { type: "turn_started", turn_id: "turn-1", started_at: 1787961601 },
      },
      {
        timestamp: "2026-08-29T00:00:02Z",
        type: "event_msg",
        payload: {
          type: "plan_update",
          explanation: "implementation",
          plan: [
            { step: "inspect", status: "completed" },
            { step: "patch", status: "in_progress" },
          ],
        },
      },
      {
        timestamp: "2026-08-29T00:00:02Z",
        type: "event_msg",
        payload: { type: "goal_update", goal_id: "goal-1", objective: "ship importer" },
      },
      {
        timestamp: "2026-08-29T00:00:03Z",
        type: "event_msg",
        payload: {
          type: "collab_agent_spawn_end",
          call_id: "spawn-1",
          sender_thread_id: "thread-child",
          new_thread_id: "thread-grandchild",
          prompt: "research",
          status: "running",
        },
      },
      {
        timestamp: "2026-08-29T00:00:04Z",
        type: "event_msg",
        payload: { type: "context_compacted" },
      },
      {
        timestamp: "2026-08-29T00:00:05Z",
        type: "event_msg",
        payload: { type: "thread_rolled_back", num_turns: 2 },
      },
      {
        timestamp: "2026-08-29T00:00:06Z",
        type: "event_msg",
        payload: { type: "turn_aborted", turn_id: "turn-1", reason: "interrupted" },
      },
      {
        timestamp: "2026-08-29T00:00:07Z",
        type: "event_msg",
        payload: {
          type: "future_protocol_event",
          access_token: "must-not-survive",
          detail: "kept",
        },
      },
      {
        timestamp: "2026-08-29T00:00:08Z",
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "work" }] },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n")
    const input: SessionScanInput = {
      fs,
      home: "",
      pickedFiles: [{ name: "rollout-rich.jsonl", path: "/p/rollout-rich.jsonl", content: rich }],
    }
    const list = await codexSessionSource.listSessions(input)
    const conversation = await codexSessionSource.parseSession(list[0].ref, input)
    expect(conversation.session).toMatchObject({
      id: "import:codex:thread-child",
      kind: "subagent",
      parentSessionId: "import:codex:thread-root",
      importLifecycle: { status: "interrupted" },
    })

    const graph = await codexSessionSource.parseGraph!(list[0].ref, input)
    const canonical = graph.nodes[0].session
    expect(canonical.header).toMatchObject({
      source: { version: "0.150.1" },
      runtimeBinding: { nativeSessionId: "thread-child", presetId: "codex" },
      lineage: { kind: "subagent", parentNativeSessionId: "thread-root" },
      lifecycle: { status: "interrupted" },
    })
    expect(canonical.plans?.[0].steps).toEqual(["inspect", "patch"])
    expect(canonical.goals?.[0]).toMatchObject({ goalId: "goal-1", description: "ship importer" })
    expect(canonical.tasks?.[0]).toMatchObject({
      taskId: "spawn-1",
      status: "running",
      childCanonicalSessionId: "canon:codex:import:codex:thread-grandchild",
    })
    expect(canonical.history?.map((event) => event.kind)).toEqual(["compaction", "rollback"])
    const diagnostic = canonical.recordedEvents?.find((event) => event.event.kind === "diagnostic")
    expect(JSON.stringify(diagnostic)).not.toContain("must-not-survive")
    expect(graph.nodes[0].loss.losses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "event_msg.future_protocol_event", kind: "approximated" }),
      ])
    )
  })

  it("groups parent and child rollout artifacts into one graph and hides the child top-level row", async () => {
    const rollout = (id: string, parent?: string) =>
      [
        {
          timestamp: "2026-08-29T00:00:00Z",
          type: "session_meta",
          payload: { id, ...(parent ? { parent_thread_id: parent } : {}) },
        },
        {
          timestamp: "2026-08-29T00:00:01Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: `work in ${id}` }],
          },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n")
    const input: SessionScanInput = {
      fs,
      home: "",
      pickedFiles: [
        { name: "rollout-root.jsonl", path: "/p/rollout-root.jsonl", content: rollout("root") },
        {
          name: "rollout-child.jsonl",
          path: "/p/rollout-child.jsonl",
          content: rollout("child", "root"),
        },
      ],
    }

    const list = await codexSessionSource.listSessions(input)
    expect(list.map((summary) => summary.ref.originalSessionId)).toEqual(["root"])

    const graph = await codexSessionSource.parseGraph!(list[0].ref, input)
    expect(graph.nodes).toHaveLength(2)
    const child = graph.nodes.find(
      (node) => node.session.header.runtimeBinding?.nativeSessionId === "child"
    )
    expect(child?.session.header.lineage).toMatchObject({
      kind: "subagent",
      parentNativeSessionId: "root",
      parentCanonicalSessionId: graph.rootCanonicalSessionId,
    })
  })
})

describe("summarizeCodexFile (lightweight scan)", () => {
  it("pulls title/cwd/session id and counts message-emitting items", () => {
    const s = summarizeCodexFile(CONTENT, "/p/rollout.jsonl")
    expect(s).not.toBeNull()
    expect(s!.cwd).toBe("/work")
    expect(s!.ref.originalSessionId).toBe("cx-1")
    expect(s!.title).toBe("fix the bug") // first user message text
    // message(user) + reasoning + function_call + message(assistant) = 4;
    // ghost_snapshot and function_call_output add none.
    expect(s!.messageCount).toBe(4)
  })

  it("returns null when the rollout carries no importable turns", () => {
    const meta = JSON.stringify({ type: "session_meta", payload: { id: "x", cwd: "/w" } })
    expect(summarizeCodexFile(meta, "/p/empty.jsonl")).toBeNull()
  })
})
