import type { ClaudeEvent, SendOptions } from "@/lib/claude/types"

import { streamText } from "ai"

import { resolveStandaloneProvider } from "./resolve-standalone-provider"
import { runStandaloneTurn } from "./standalone-engine"

jest.mock("./resolve-standalone-provider", () => ({ resolveStandaloneProvider: jest.fn() }))
jest.mock("@/lib/ai/provider-consumption", () => ({
  createFeatureProviderModel: jest.fn(() => ({ __model: true })),
}))
jest.mock("@/lib/runtime/streaming-fetch", () => ({
  getStreamingFetch: () => globalThis.fetch,
  browserDirectHeaders: () => ({}),
}))
jest.mock("@/lib/ai/agent/agent-executor", () => ({
  composeSystem: (...parts: Array<string | undefined>) => parts.filter(Boolean).join("\n\n"),
}))
jest.mock("ai", () => ({
  convertToModelMessages: (m: unknown) => m,
  streamText: jest.fn(),
}))
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: { getState: () => ({ settings: {} }) },
}))

const mockResolve = resolveStandaloneProvider as jest.MockedFunction<
  typeof resolveStandaloneProvider
>

const resolved = {
  kind: "resolved" as const,
  providerId: "anthropic",
  protocol: "anthropic" as const,
  apiKey: "sk",
  baseURL: undefined,
  model: "claude-sonnet-4-6",
  isCustomProvider: false,
  useProxy: false,
}

function fakeStream(parts: unknown[], usage?: unknown) {
  return (() => ({
    fullStream: (async function* () {
      for (const p of parts) yield p
    })(),
    usage: Promise.resolve(usage ?? { promptTokens: 3, completionTokens: 7 }),
  })) as never
}

function run(over: Partial<Parameters<typeof runStandaloneTurn>[0]> = {}) {
  const events: ClaudeEvent[] = []
  const controller = new AbortController()
  const promise = runStandaloneTurn({
    sessionId: "s1",
    messages: [],
    sendOptions: { systemPrompt: "be nice" } as SendOptions,
    emit: (e) => events.push(e),
    signal: controller.signal,
    streamTextImpl: fakeStream([{ type: "text-delta", text: "hi" }]),
    ...over,
  })
  return { events, controller, promise }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockResolve.mockReturnValue(resolved)
})

describe("runStandaloneTurn", () => {
  it("streams assistant snapshots, a result envelope, then a clean session_ended", async () => {
    const { events, promise } = run({
      streamTextImpl: fakeStream([
        { type: "text-delta", text: "Hello" },
        { type: "finish", usage: { promptTokens: 1, completionTokens: 2 } },
      ]),
    })
    await promise

    const eventEnvelopes = events.filter((e) => e.type === "event") as Array<{
      event: { type: string }
    }>
    expect(eventEnvelopes.some((e) => e.event.type === "assistant")).toBe(true)
    expect(eventEnvelopes.some((e) => e.event.type === "result")).toBe(true)
    const last = events.at(-1)!
    expect(last).toEqual({ type: "session_ended", sessionId: "s1" })
  })

  it("emits session_ended.error when no provider is configured", async () => {
    mockResolve.mockReturnValue({
      kind: "unresolved",
      reason: 'Provider "anthropic" is missing both an API key and a base URL.',
      attemptedProviderIds: ["anthropic"],
    })
    const { events, promise } = run()
    await promise
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "session_ended",
      sessionId: "s1",
      error: expect.stringContaining("missing both"),
    })
  })

  it("surfaces a provider/stream error as session_ended.error", async () => {
    const { events, promise } = run({
      streamTextImpl: (() => {
        throw new Error("401 unauthorized")
      }) as never,
    })
    await promise
    expect(events.at(-1)).toMatchObject({
      type: "session_ended",
      sessionId: "s1",
      error: expect.stringContaining("401"),
    })
  })

  it("treats an aborted turn as a clean stop (no error)", async () => {
    const controller = new AbortController()
    controller.abort()
    const events: ClaudeEvent[] = []
    await runStandaloneTurn({
      sessionId: "s1",
      messages: [],
      sendOptions: {} as SendOptions,
      emit: (e) => events.push(e),
      signal: controller.signal,
      streamTextImpl: (() => {
        const err = new Error("aborted")
        err.name = "AbortError"
        throw err
      }) as never,
    })
    expect(events.at(-1)).toEqual({ type: "session_ended", sessionId: "s1" })
    expect(events.some((e) => e.type === "session_ended" && "error" in e && e.error)).toBe(false)
  })

  it("passes the composed system prompt and resolved model to streamText", async () => {
    const streamSpy = jest.fn(fakeStream([{ type: "text-delta", text: "x" }]))
    await run({
      streamTextImpl: streamSpy as never,
      sendOptions: { systemPrompt: "SYS" } as SendOptions,
    }).promise
    expect(streamSpy).toHaveBeenCalledWith(
      expect.objectContaining({ system: "SYS", model: { __model: true } })
    )
  })

  it("omits the system field when there is no system prompt", async () => {
    const streamSpy = jest.fn(fakeStream([{ type: "text-delta", text: "x" }]))
    await run({ streamTextImpl: streamSpy as never, sendOptions: {} as SendOptions }).promise
    expect(streamSpy.mock.calls[0][0]).not.toHaveProperty("system")
  })

  it("falls back to the real `ai` streamText when no impl is injected", async () => {
    ;(streamText as unknown as jest.Mock).mockReturnValue({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "viaAi" }
      })(),
      usage: Promise.resolve({ promptTokens: 1, completionTokens: 1 }),
    })
    const events: ClaudeEvent[] = []
    await runStandaloneTurn({
      sessionId: "s1",
      messages: [],
      sendOptions: {} as SendOptions,
      emit: (e) => events.push(e),
      signal: new AbortController().signal,
    })
    expect(streamText).toHaveBeenCalled()
    expect(events.at(-1)).toEqual({ type: "session_ended", sessionId: "s1" })
  })

  it("uses a default message when the unresolved reason is empty", async () => {
    mockResolve.mockReturnValue({ kind: "unresolved", reason: "", attemptedProviderIds: [] })
    const { events, promise } = run()
    await promise
    expect(events[0]).toMatchObject({ error: expect.stringContaining("No model provider") })
  })

  it("breaks out of the stream loop when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const events: ClaudeEvent[] = []
    await runStandaloneTurn({
      sessionId: "s1",
      messages: [],
      sendOptions: {} as SendOptions,
      emit: (e) => events.push(e),
      signal: controller.signal,
      streamTextImpl: fakeStream([{ type: "text-delta", text: "never-seen" }]),
    })
    // No assistant snapshot streamed (loop broke at the first guard), clean end.
    const snapshots = events.filter(
      (e) => e.type === "event" && (e as { event?: { type?: string } }).event?.type === "assistant"
    )
    expect(snapshots).toHaveLength(0)
    expect(events.at(-1)).toEqual({ type: "session_ended", sessionId: "s1" })
  })

  it("stringifies a non-Error thrown value in session_ended.error", async () => {
    const { events, promise } = run({
      streamTextImpl: (() => {
        throw "string failure"
      }) as never,
    })
    await promise
    expect(events.at(-1)).toMatchObject({ type: "session_ended", error: "string failure" })
  })

  it("still seals cleanly when the usage promise rejects", async () => {
    const stream = (() => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "hi" }
      })(),
      usage: Promise.reject(new Error("no usage")),
    })) as never
    const { events, promise } = run({ streamTextImpl: stream })
    await promise
    expect(events.at(-1)).toEqual({ type: "session_ended", sessionId: "s1" })
  })
})
