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
