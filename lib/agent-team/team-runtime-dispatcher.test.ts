import {
  dispatchTeamMention,
  TEAM_MESSAGE_METADATA_KEYS,
  type RuntimeStreamEvent,
  type RuntimeStreamer,
  type ToolCallEntry,
} from "./team-runtime-dispatcher"
import type { MentionTarget } from "./runtime-targets"
import type { AgentTeamMessage } from "@/types/agent/agent-team"

function makeVirtualTarget(): MentionTarget {
  return {
    kind: "virtual",
    id: "__virtual_codex__",
    name: "codex",
    runtime: "codex",
    description: "OpenAI Codex CLI",
  }
}

function makeStreamer(events: RuntimeStreamEvent[]): RuntimeStreamer {
  return {
    stream: async function* () {
      for (const e of events) yield e
    },
  }
}

function makeWriter() {
  const messages = new Map<string, AgentTeamMessage>()
  const writes: AgentTeamMessage[] = []
  const writer = {
    upsertMessage: (m: AgentTeamMessage) => {
      messages.set(m.id, m)
      writes.push({ ...m })
    },
  }
  return { writer, messages, writes }
}

describe("dispatchTeamMention", () => {
  it("writes a user message and an agent placeholder, then accumulates text deltas", async () => {
    const { writer, messages, writes } = makeWriter()
    const streamer = makeStreamer([
      { kind: "text", delta: "Hello " },
      { kind: "text", delta: "there." },
      { kind: "done", tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
    ])

    const result = await dispatchTeamMention(
      {
        teamId: "team-1",
        target: makeVirtualTarget(),
        prompt: "say hi",
        rawText: "@codex say hi",
      },
      { writer, streamer }
    )

    expect(result.ok).toBe(true)
    expect(result.finalText).toBe("Hello there.")
    expect(result.tokenUsage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 })

    expect(messages.size).toBe(2)
    const user = messages.get(result.userMessageId)
    const agent = messages.get(result.agentMessageId)
    expect(user?.content).toBe("@codex say hi")
    expect(user?.senderName).toBe("You")
    expect(user?.recipientName).toBe("codex")
    expect(agent?.content).toBe("Hello there.")
    expect(agent?.senderName).toBe("codex")
    expect(agent?.metadata?.[TEAM_MESSAGE_METADATA_KEYS.STREAMING]).toBeUndefined()

    expect(writes.length).toBeGreaterThanOrEqual(5)

    const intermediate = writes.find(
      (w) => w.id === result.agentMessageId && w.content === "Hello "
    )
    expect(intermediate?.metadata?.[TEAM_MESSAGE_METADATA_KEYS.STREAMING]).toBe(true)
  })

  it("uses a custom user display name when provided", async () => {
    const { writer, messages } = makeWriter()
    const streamer = makeStreamer([{ kind: "done" }])

    const result = await dispatchTeamMention(
      {
        teamId: "team-1",
        target: makeVirtualTarget(),
        prompt: "",
        rawText: "@codex",
        userDisplayName: "Max",
      },
      { writer, streamer }
    )

    expect(messages.get(result.userMessageId)?.senderName).toBe("Max")
  })

  it("formats runtime errors and clears the streaming flag", async () => {
    const { writer, messages, writes } = makeWriter()
    const streamer: RuntimeStreamer = {
      stream: async function* () {
        yield { kind: "text", delta: "partial " }
        yield { kind: "error", message: "rate limited" }
        yield { kind: "done" }
      },
    }

    const result = await dispatchTeamMention(
      {
        teamId: "team-1",
        target: makeVirtualTarget(),
        prompt: "go",
        rawText: "@codex go",
      },
      { writer, streamer }
    )

    expect(result.ok).toBe(false)
    expect(result.error).toBe("rate limited")
    const agent = messages.get(result.agentMessageId)
    expect(agent?.content).toContain("partial ")
    expect(agent?.content).toContain("❌ rate limited")
    expect(agent?.metadata?.[TEAM_MESSAGE_METADATA_KEYS.STREAMING]).toBeUndefined()
    expect(agent?.metadata?.[TEAM_MESSAGE_METADATA_KEYS.ERROR]).toBe(true)
    expect(writes.some((w) => w.metadata?.[TEAM_MESSAGE_METADATA_KEYS.ERROR] === true)).toBe(true)
  })

  it("captures thrown errors from the streamer", async () => {
    const { writer, messages } = makeWriter()
    const streamer: RuntimeStreamer = {
      stream: async function* () {
        yield { kind: "text", delta: "boom-" }
        throw new Error("network down")
      },
    }

    const result = await dispatchTeamMention(
      {
        teamId: "t",
        target: makeVirtualTarget(),
        prompt: "x",
        rawText: "@codex x",
      },
      { writer, streamer }
    )

    expect(result.ok).toBe(false)
    expect(result.error).toBe("network down")
    expect(messages.get(result.agentMessageId)?.content).toContain("network down")
  })

  it("mirrors structured tool events into metadata.toolCalls", async () => {
    const { writer, messages } = makeWriter()
    const streamer = makeStreamer([
      { kind: "tool_start", id: "t1", name: "ls", input: '{"dir":"/"}' },
      { kind: "text", delta: "Listing... " },
      { kind: "tool_result", id: "t1", output: "file1\nfile2" },
      { kind: "text", delta: "done." },
      { kind: "done" },
    ])

    const result = await dispatchTeamMention(
      {
        teamId: "t",
        target: makeVirtualTarget(),
        prompt: "list files",
        rawText: "@codex list files",
      },
      { writer, streamer }
    )

    expect(result.ok).toBe(true)
    expect(result.finalText).toBe("Listing... done.")
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls?.[0]).toEqual<ToolCallEntry>({
      id: "t1",
      name: "ls",
      input: '{"dir":"/"}',
      output: "file1\nfile2",
      status: "complete",
    })

    const agent = messages.get(result.agentMessageId)
    const calls = agent?.metadata?.[TEAM_MESSAGE_METADATA_KEYS.TOOL_CALLS] as ToolCallEntry[]
    expect(calls?.[0].status).toBe("complete")
    // No legacy inline preview text — content is only the assistant text.
    expect(agent?.content).not.toContain("> ran ls")
  })

  it("reports readable files immediately and written files after a successful result", async () => {
    const { writer } = makeWriter()
    const onFileActivity = jest.fn()
    const streamer = makeStreamer([
      { kind: "tool_start", id: "read", name: "Read", input: '{"file_path":"src/a.ts"}' },
      { kind: "tool_result", id: "read", output: "source" },
      { kind: "tool_start", id: "write", name: "Write", input: '{"file_path":"src/b.ts"}' },
      { kind: "tool_result", id: "write", output: "created" },
      { kind: "tool_start", id: "edit", name: "Edit", input: '{"file_path":"src/c.ts"}' },
      { kind: "tool_result", id: "edit", output: "failed", isError: true },
      { kind: "done" },
    ])

    await dispatchTeamMention(
      {
        teamId: "t",
        target: makeVirtualTarget(),
        prompt: "work",
        rawText: "@codex work",
      },
      { writer, streamer, onFileActivity }
    )

    expect(onFileActivity).toHaveBeenNthCalledWith(1, {
      path: "src/a.ts",
      timing: "start",
    })
    expect(onFileActivity).toHaveBeenNthCalledWith(2, {
      path: "src/b.ts",
      timing: "success",
    })
    expect(onFileActivity).toHaveBeenCalledTimes(2)
  })

  it("marks tool result with isError as 'error' status", async () => {
    const { writer, messages } = makeWriter()
    const streamer = makeStreamer([
      { kind: "tool_start", id: "t1", name: "fetch" },
      { kind: "tool_result", id: "t1", output: "boom", isError: true },
      { kind: "done" },
    ])

    const result = await dispatchTeamMention(
      {
        teamId: "t",
        target: makeVirtualTarget(),
        prompt: "x",
        rawText: "@codex x",
      },
      { writer, streamer }
    )

    const calls = messages.get(result.agentMessageId)?.metadata?.[
      TEAM_MESSAGE_METADATA_KEYS.TOOL_CALLS
    ] as ToolCallEntry[]
    expect(calls?.[0].status).toBe("error")
  })

  it("aborts mid-stream when an external signal fires", async () => {
    const ac = new AbortController()
    const { writer, messages } = makeWriter()

    const streamer: RuntimeStreamer = {
      stream: async function* ({ signal }) {
        yield { kind: "text", delta: "first " }
        ac.abort()
        if (signal.aborted) return
        yield { kind: "text", delta: "second" }
      },
    }

    const result = await dispatchTeamMention(
      {
        teamId: "t",
        target: makeVirtualTarget(),
        prompt: "x",
        rawText: "@codex x",
        signal: ac.signal,
      },
      { writer, streamer }
    )

    expect(result.ok).toBe(false)
    expect(result.error).toBe("aborted")
    const agent = messages.get(result.agentMessageId)
    expect(agent?.content.startsWith("first")).toBe(true)
    expect(agent?.content.includes("second")).toBe(false)
  })

  it("records the runtime + dispatch target/prompt in message metadata", async () => {
    const { writer, messages } = makeWriter()
    const streamer = makeStreamer([{ kind: "text", delta: "ok" }, { kind: "done" }])

    const result = await dispatchTeamMention(
      {
        teamId: "t",
        target: {
          kind: "virtual",
          id: "__virtual_claude__",
          name: "claude",
          runtime: "claude",
          description: "Anthropic Claude API",
        },
        prompt: "ok",
        rawText: "@claude ok",
      },
      { writer, streamer }
    )

    const agent = messages.get(result.agentMessageId)
    expect(agent?.metadata?.[TEAM_MESSAGE_METADATA_KEYS.RUNTIME]).toBe("claude")
    expect(agent?.metadata?.[TEAM_MESSAGE_METADATA_KEYS.DISPATCH_TARGET_ID]).toBe(
      "__virtual_claude__"
    )
    expect(agent?.metadata?.[TEAM_MESSAGE_METADATA_KEYS.DISPATCH_PROMPT]).toBe("ok")
  })

  it("forwards conversation history to the streamer", async () => {
    const { writer } = makeWriter()
    const seen: { history?: readonly unknown[] }[] = []
    const streamer: RuntimeStreamer = {
      stream: async function* (params) {
        seen.push({ history: params.history })
        yield { kind: "done" }
      },
    }

    const history = [
      { role: "user" as const, speakerName: "You", content: "earlier", timestamp: new Date() },
    ]
    await dispatchTeamMention(
      {
        teamId: "t",
        target: makeVirtualTarget(),
        prompt: "follow up",
        rawText: "@codex follow up",
        history,
      },
      { writer, streamer }
    )

    expect(seen[0].history).toEqual(history)
  })

  it("persists tokenUsage in metadata when the runtime reports it", async () => {
    const { writer, messages } = makeWriter()
    const streamer = makeStreamer([
      { kind: "text", delta: "ok" },
      { kind: "done", tokenUsage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 } },
    ])

    const result = await dispatchTeamMention(
      {
        teamId: "t",
        target: makeVirtualTarget(),
        prompt: "x",
        rawText: "@codex x",
      },
      { writer, streamer }
    )

    const agent = messages.get(result.agentMessageId)
    expect(agent?.metadata?.[TEAM_MESSAGE_METADATA_KEYS.TOKEN_USAGE]).toEqual({
      promptTokens: 5,
      completionTokens: 7,
      totalTokens: 12,
    })
  })
})
