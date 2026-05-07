/**
 * Unit tests for the runtime streamers. The Claude path is covered by mocking
 * `streamText` from `ai`; the external path uses an injected `executeStreaming`
 * iterable so we never touch a real ACP transport.
 */

jest.mock("ai", () => ({
  streamText: jest.fn(),
}))

import { streamText } from "ai"
import {
  createCompositeStreamer,
  externalAgentStream,
  type ExternalAgentStreamerHooks,
} from "./runtime-streamers"
import type { ExternalAgentEvent } from "@/types/agent/external-agent"
import type { RuntimeStreamEvent } from "./team-runtime-dispatcher"
import type { MentionTarget } from "./runtime-targets"
import type { ConversationTurn } from "./conversation-context"

const mockedStreamText = streamText as unknown as jest.Mock

afterEach(() => {
  mockedStreamText.mockReset()
})

function makeAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const x of items) yield x
    },
  }
}

async function collect(iter: AsyncIterable<RuntimeStreamEvent>): Promise<RuntimeStreamEvent[]> {
  const out: RuntimeStreamEvent[] = []
  for await (const e of iter) out.push(e)
  return out
}

describe("createCompositeStreamer (Claude path)", () => {
  it("emits text + done with token usage from streamText", async () => {
    mockedStreamText.mockReturnValue({
      textStream: makeAsyncIterable(["hello ", "world"]),
      usage: Promise.resolve({ inputTokens: 4, outputTokens: 6, totalTokens: 10 }),
    })

    const streamer = createCompositeStreamer({
      claude: { model: {} as never },
      external: {} as ExternalAgentStreamerHooks,
    })
    const target: MentionTarget = {
      kind: "virtual",
      id: "__virtual_claude__",
      name: "claude",
      runtime: "claude",
      description: "",
    }
    const events = await collect(
      streamer.stream({
        runtime: "claude",
        prompt: "hi",
        target,
        signal: new AbortController().signal,
      })
    )

    const texts = events.filter((e) => e.kind === "text")
    expect(texts).toEqual([
      { kind: "text", delta: "hello " },
      { kind: "text", delta: "world" },
    ])
    const done = events.find((e) => e.kind === "done")
    expect(done).toEqual({
      kind: "done",
      tokenUsage: { promptTokens: 4, completionTokens: 6, totalTokens: 10 },
    })
  })

  it("yields an error event when streamText throws", async () => {
    mockedStreamText.mockReturnValue({
      textStream: (async function* () {
        yield "partial"
        throw new Error("model boom")
      })(),
      usage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    })

    const streamer = createCompositeStreamer({
      claude: { model: {} as never },
      external: {} as ExternalAgentStreamerHooks,
    })
    const events = await collect(
      streamer.stream({
        runtime: "claude",
        prompt: "x",
        target: {
          kind: "virtual",
          id: "__virtual_claude__",
          name: "claude",
          runtime: "claude",
          description: "",
        },
        signal: new AbortController().signal,
      })
    )

    expect(events.some((e) => e.kind === "error" && e.message === "model boom")).toBe(true)
    expect(events.find((e) => e.kind === "done")).toBeDefined()
  })

  it("passes conversation history as a messages array to streamText", async () => {
    mockedStreamText.mockReturnValue({
      textStream: makeAsyncIterable(["ok"]),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
    })

    const streamer = createCompositeStreamer({
      claude: { model: {} as never },
      external: {} as ExternalAgentStreamerHooks,
    })

    const history: ConversationTurn[] = [
      { role: "user", speakerName: "You", content: "first", timestamp: new Date() },
      { role: "assistant", speakerName: "Claude", content: "answer", timestamp: new Date() },
    ]
    await collect(
      streamer.stream({
        runtime: "claude",
        prompt: "follow-up",
        target: {
          kind: "virtual",
          id: "__virtual_claude__",
          name: "claude",
          runtime: "claude",
          description: "",
        },
        signal: new AbortController().signal,
        history,
      })
    )

    const call = mockedStreamText.mock.calls[0][0]
    expect(call.messages).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "[Claude]: answer" },
      { role: "user", content: "follow-up" },
    ])
    // `prompt` should not be passed when messages are used.
    expect(call.prompt).toBeUndefined()
  })
})

describe("externalAgentStream", () => {
  function makeHooks(
    events: ExternalAgentEvent[],
    agentId: string | null = "agent-codex"
  ): {
    hooks: ExternalAgentStreamerHooks
    setActiveCalls: string[]
    executePrompts: string[]
  } {
    const setActiveCalls: string[] = []
    const executePrompts: string[] = []
    return {
      setActiveCalls,
      executePrompts,
      hooks: {
        setActiveAgent: (id) => setActiveCalls.push(id),
        executeStreaming: (prompt) => {
          executePrompts.push(prompt)
          return makeAsyncIterable(events)
        },
        resolveAgentId: () => agentId,
      },
    }
  }

  it("translates message_delta + done events", async () => {
    const { hooks, setActiveCalls } = makeHooks([
      {
        type: "message_delta",
        delta: { type: "text", text: "abc" },
        timestamp: new Date(),
      },
      {
        type: "message_delta",
        delta: { type: "text", text: "def" },
        timestamp: new Date(),
      },
      {
        type: "done",
        success: true,
        tokenUsage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
        timestamp: new Date(),
      },
    ])

    const events = await collect(externalAgentStream("hi", "codex", hooks))
    expect(setActiveCalls).toEqual(["agent-codex"])
    expect(events).toEqual([
      { kind: "text", delta: "abc" },
      { kind: "text", delta: "def" },
      {
        kind: "done",
        tokenUsage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
      },
    ])
  })

  it("emits a friendly error when no agent is configured", async () => {
    const { hooks, setActiveCalls } = makeHooks([], null)
    const events = await collect(externalAgentStream("hi", "gemini-cli", hooks))
    expect(setActiveCalls).toEqual([])
    expect(events[0]).toEqual({
      kind: "error",
      message:
        'No external agent configured for "gemini-cli". Open Settings → External Agents to add one.',
    })
    expect(events[1]).toEqual({ kind: "done" })
  })

  it("translates structured tool start + result events", async () => {
    const { hooks } = makeHooks([
      {
        type: "tool_use_start",
        toolUseId: "t1",
        toolName: "ls",
        rawInput: { dir: "/" },
        timestamp: new Date(),
      },
      {
        type: "tool_result",
        toolUseId: "t1",
        result: "file1\nfile2",
        timestamp: new Date(),
      },
      { type: "done", success: true, timestamp: new Date() },
    ])

    const events = await collect(externalAgentStream("ls", "codex", hooks))
    const startEvent = events.find((e) => e.kind === "tool_start")
    const resultEvent = events.find((e) => e.kind === "tool_result")
    expect(startEvent).toEqual({
      kind: "tool_start",
      id: "t1",
      name: "ls",
      input: '{"dir":"/"}',
    })
    expect(resultEvent).toEqual({
      kind: "tool_result",
      id: "t1",
      output: "file1\nfile2",
      isError: undefined,
    })
  })

  it("serializes object tool results and propagates isError", async () => {
    const { hooks } = makeHooks([
      {
        type: "tool_use_start",
        toolUseId: "t2",
        toolName: "fetch",
        timestamp: new Date(),
      },
      {
        type: "tool_result",
        toolUseId: "t2",
        result: { status: 500, body: "boom" },
        isError: true,
        timestamp: new Date(),
      },
      { type: "done", success: false, timestamp: new Date() },
    ])

    const events = await collect(externalAgentStream("x", "codex", hooks))
    const result = events.find((e) => e.kind === "tool_result")
    expect(result).toEqual({
      kind: "tool_result",
      id: "t2",
      output: '{"status":500,"body":"boom"}',
      isError: true,
    })
  })

  it("translates an error event verbatim", async () => {
    const { hooks } = makeHooks([
      {
        type: "error",
        error: "rate limited",
        timestamp: new Date(),
      },
      { type: "done", success: false, timestamp: new Date() },
    ])

    const events = await collect(externalAgentStream("x", "codex", hooks))
    expect(events.some((e) => e.kind === "error" && e.message === "rate limited")).toBe(true)
  })

  it("captures thrown executeStreaming errors as error events", async () => {
    const hooks: ExternalAgentStreamerHooks = {
      setActiveAgent: () => undefined,
      resolveAgentId: () => "agent-codex",
      executeStreaming: () => ({
        async *[Symbol.asyncIterator]() {
          throw new Error("stream broken")
        },
      }),
    }
    const events = await collect(externalAgentStream("x", "codex", hooks))
    expect(events.some((e) => e.kind === "error" && e.message === "stream broken")).toBe(true)
    expect(events.find((e) => e.kind === "done")).toBeDefined()
  })

  it("returns null translation for events that have no narrative impact", async () => {
    const { hooks } = makeHooks([
      { type: "session_start", timestamp: new Date(), capabilities: undefined },
      {
        type: "message_delta",
        delta: { type: "text", text: "ok" },
        timestamp: new Date(),
      },
      { type: "done", success: true, timestamp: new Date() },
    ])
    const events = await collect(externalAgentStream("x", "codex", hooks))
    expect(events).toEqual([
      { kind: "text", delta: "ok" },
      { kind: "done", tokenUsage: undefined },
    ])
  })

  it("prepends conversation history preamble when supplied", async () => {
    const { hooks, executePrompts } = makeHooks([
      { type: "done", success: true, timestamp: new Date() },
    ])

    const history: ConversationTurn[] = [
      { role: "user", speakerName: "You", content: "first", timestamp: new Date() },
      { role: "assistant", speakerName: "Codex", content: "answer", timestamp: new Date() },
    ]
    await collect(externalAgentStream("follow-up", "codex", hooks, history))
    expect(executePrompts[0]).toContain("[Conversation so far]")
    expect(executePrompts[0]).toContain("You: first")
    expect(executePrompts[0]).toContain("Codex: answer")
    expect(executePrompts[0]).toContain("[New request]")
    expect(executePrompts[0]).toContain("follow-up")
  })

  it("sends prompt verbatim when history is empty", async () => {
    const { hooks, executePrompts } = makeHooks([
      { type: "done", success: true, timestamp: new Date() },
    ])
    await collect(externalAgentStream("just ask", "codex", hooks))
    expect(executePrompts[0]).toBe("just ask")
  })
})
