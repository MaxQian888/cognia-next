import type { UIMessage } from "ai"

import { deriveRunRecord, nextToolTimestamps } from "./run-record"
import { IDLE_TIMING, type RunStatus, type RunTiming } from "./run-status"

const SID = "s1"

function user(id: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text: "hi" }] } as unknown as UIMessage
}

function assistant(id: string, parts: unknown[]): UIMessage {
  return { id, role: "assistant", parts } as unknown as UIMessage
}

function tool(toolCallId: string, name: string, state: string, input: unknown): unknown {
  return { type: `tool-${name}`, state, input, toolCallId }
}

function todoWrite(toolCallId: string, todos: unknown[]): unknown {
  return { type: "tool-TodoWrite", state: "output-available", input: { todos }, toolCallId }
}

function subagent(id: string, status: string): unknown {
  return {
    type: "subagent",
    subagentId: id,
    parentSessionId: SID,
    name: `agent-${id}`,
    status,
    progress: 0,
    startedAt: 1000,
  }
}

function base(overrides: Partial<Parameters<typeof deriveRunRecord>[0]> = {}) {
  return deriveRunRecord({
    sessionId: SID,
    runId: 1,
    messages: [],
    runTiming: IDLE_TIMING,
    status: "idle" as RunStatus,
    ...overrides,
  })
}

describe("deriveRunRecord", () => {
  it("collects tools in message-then-part order, most-recent last", () => {
    const messages = [
      user("u1"),
      assistant("a1", [
        tool("t1", "Read", "output-available", { file_path: "/a" }),
        tool("t2", "Grep", "output-available", { pattern: "x" }),
      ]),
      assistant("a2", [tool("t3", "Bash", "input-available", { command: "ls" })]),
    ]
    const rec = base({ messages, status: "streaming" })
    expect(rec.tools.map((t) => t.id)).toEqual(["t1", "t2", "t3"])
    expect(rec.counts.tools).toBe(3)
  })

  it("only collects the latest assistant run across a turn boundary", () => {
    const messages = [
      user("u1"),
      assistant("a1", [tool("t1", "Read", "output-available", { file_path: "/a" })]),
      user("u2"),
      assistant("a2", [tool("t2", "Bash", "input-available", { command: "ls" })]),
    ]
    const rec = base({ messages, status: "streaming" })
    expect(rec.tools.map((t) => t.id)).toEqual(["t2"])
  })

  it("marks a completed tool with a result summary and end timestamp", () => {
    const messages = [
      user("u1"),
      assistant("a1", [
        tool("t1", "edit", "output-available", { old_string: "a\nb", new_string: "x\ny\nz" }),
      ]),
    ]
    const rec = base({
      messages,
      status: "streaming",
      toolTimestamps: { t1: { startedAt: 100, endedAt: 250 } },
    })
    const entry = rec.tools[0]!
    expect(entry.status).toBe("output-available")
    expect(entry.startedAt).toBe(100)
    expect(entry.endedAt).toBe(250)
    expect(entry.resultSummary).toEqual({ kind: "diff", added: 3, removed: 2, tone: "success" })
  })

  it("splits running tools into runningTools", () => {
    const messages = [
      user("u1"),
      assistant("a1", [
        tool("t1", "Read", "output-available", { file_path: "/a" }),
        tool("t2", "Bash", "input-available", { command: "ls" }),
      ]),
    ]
    const rec = base({ messages, status: "streaming" })
    expect(rec.runningTools.map((t) => t.id)).toEqual(["t2"])
  })

  it("excludes TodoWrite from tools and uses the latest snapshot for todos", () => {
    const messages = [
      user("u1"),
      assistant("a1", [
        todoWrite("td1", [{ content: "a", status: "completed" }]),
        tool("t1", "Bash", "input-available", { command: "ls" }),
        todoWrite("td2", [
          { content: "a", status: "completed" },
          { content: "b", status: "in_progress" },
        ]),
      ]),
    ]
    const rec = base({ messages, status: "streaming" })
    expect(rec.tools.map((t) => t.id)).toEqual(["t1"])
    expect(rec.todos.map((t) => t.content)).toEqual(["a", "b"])
    expect(rec.todoCounts).toEqual({ done: 1, total: 2 })
  })

  it("collects concurrent subagent parts", () => {
    const messages = [
      user("u1"),
      assistant("a1", [subagent("sa1", "running"), subagent("sa2", "running")]),
    ]
    const rec = base({ messages, status: "streaming" })
    expect(rec.subagentIds).toEqual(["sa1", "sa2"])
    expect(rec.counts.subagents).toBe(2)
    expect(rec.subagentParts).toHaveLength(2)
  })

  it("skips non-tool parts and falls back to a positional id without a toolCallId", () => {
    const messages = [
      user("u1"),
      assistant("a1", [
        { type: "text", text: "thinking" },
        { type: "tool-Bash", state: "input-available", input: { command: "ls" } },
      ]),
    ]
    const rec = base({ messages, status: "streaming" })
    expect(rec.tools).toHaveLength(1)
    expect(rec.tools[0]!.id).toBe("0-1")
  })

  it("tolerates an assistant message with no parts", () => {
    const messages = [user("u1"), { id: "a1", role: "assistant" } as unknown as UIMessage]
    const rec = base({ messages, status: "streaming" })
    expect(rec.tools).toEqual([])
  })

  it("leaves timestamps undefined when no toolTimestamps are supplied", () => {
    const messages = [
      user("u1"),
      assistant("a1", [tool("t1", "Read", "input-available", { file_path: "/a" })]),
    ]
    const rec = base({ messages, status: "streaming" })
    expect(rec.tools[0]!.startedAt).toBeUndefined()
    expect(rec.tools[0]!.endedAt).toBeUndefined()
  })

  it("passes the run timing through untouched", () => {
    const timing: RunTiming = { startedAt: 5, pausedAt: 20, pausedAccumMs: 7 }
    const rec = base({ runTiming: timing, status: "awaiting_approval" })
    expect(rec.timing).toEqual(timing)
  })

  describe("status mapping", () => {
    it("maps streaming → running", () => {
      expect(base({ status: "streaming" }).status).toBe("running")
    })
    it("maps awaiting_approval → awaiting_approval", () => {
      expect(base({ status: "awaiting_approval" }).status).toBe("awaiting_approval")
    })
    it("maps error → error", () => {
      expect(base({ status: "error" }).status).toBe("error")
    })
    it("maps idle with work → done", () => {
      const messages = [
        user("u1"),
        assistant("a1", [tool("t1", "Read", "output-available", { file_path: "/a" })]),
      ]
      expect(base({ messages, status: "idle" }).status).toBe("done")
    })
    it("maps idle with no work → idle", () => {
      expect(base({ status: "idle" }).status).toBe("idle")
    })
  })
})

describe("nextToolTimestamps", () => {
  it("stamps startedAt for a newly-seen running tool", () => {
    const messages = [
      user("u1"),
      assistant("a1", [tool("t1", "Bash", "input-available", { command: "ls" })]),
    ]
    expect(nextToolTimestamps({}, messages, 500)).toEqual({ t1: { startedAt: 500 } })
  })

  it("stamps endedAt once a known tool reaches a terminal state", () => {
    const messages = [
      user("u1"),
      assistant("a1", [tool("t1", "Bash", "output-available", { command: "ls" })]),
    ]
    expect(nextToolTimestamps({ t1: { startedAt: 100 } }, messages, 400)).toEqual({
      t1: { startedAt: 100, endedAt: 400 },
    })
  })

  it("returns the same reference when nothing changes (no churn)", () => {
    const prev = { t1: { startedAt: 100, endedAt: 400 } }
    const messages = [
      user("u1"),
      assistant("a1", [tool("t1", "Bash", "output-available", { command: "ls" })]),
    ]
    expect(nextToolTimestamps(prev, messages, 900)).toBe(prev)
  })

  it("ignores TodoWrite, non-tool parts, and tool parts without a toolCallId", () => {
    const messages = [
      user("u1"),
      assistant("a1", [
        { type: "text", text: "hi" },
        todoWrite("td1", [{ content: "a", status: "pending" }]),
        { type: "tool-Bash", state: "input-available", input: {} },
      ]),
    ]
    expect(nextToolTimestamps({}, messages, 500)).toEqual({})
  })

  it("tolerates an assistant message with no parts", () => {
    const messages = [user("u1"), { id: "a1", role: "assistant" } as unknown as UIMessage]
    expect(nextToolTimestamps({}, messages, 500)).toEqual({})
  })
})
