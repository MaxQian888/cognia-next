/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"
import type { UIMessage } from "ai"

import { useSessionReport } from "./use-session-report"
import type { SessionUsageRow } from "@/lib/db/session-usage"

// useLiveQuery returns queued values in call order (messages, then usageRows).
let liveValues: unknown[] = []
let liveIdx = 0
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => liveValues[liveIdx++],
}))
jest.mock("@/lib/db/messages", () => ({ listMessages: jest.fn() }))
jest.mock("@/lib/db/session-usage", () => ({ listUsageForSession: jest.fn() }))

function setLive(messages: unknown, usage: unknown) {
  liveValues = [messages, usage]
  liveIdx = 0
}

const msg = (id: string, role: string): UIMessage =>
  ({ id, role, parts: [{ type: "text", text: "hi" }] }) as unknown as UIMessage
const row = (at: number): SessionUsageRow =>
  ({
    messageId: `m${at}`,
    sessionId: "s",
    at,
    inputTokens: 10,
    outputTokens: 5,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    durationMs: 0,
  }) as SessionUsageRow

describe("useSessionReport", () => {
  it("is loading until both queries resolve", () => {
    setLive(undefined, undefined)
    const { result } = renderHook(() => useSessionReport("s1"))
    expect(result.current.loading).toBe(true)
    expect(result.current.report).toBeNull()
  })

  it("produces a report once data is available", () => {
    setLive([msg("u1", "user"), msg("a1", "assistant")], [row(1000)])
    const { result } = renderHook(() => useSessionReport("s1", { title: "T" }))
    expect(result.current.loading).toBe(false)
    expect(result.current.report?.turns).toBe(1)
    expect(result.current.report?.title).toBe("T")
  })

  it("returns no report for a null session id", () => {
    setLive([], [])
    const { result } = renderHook(() => useSessionReport(null))
    expect(result.current.report).toBeNull()
  })

  it("falls back to imported metadata.usage when there are no live usage rows", () => {
    const assistantWithUsage = {
      id: "a1",
      role: "assistant",
      createdAt: 1000,
      parts: [{ type: "text", text: "ok" }],
      metadata: { usage: { inputTokens: 100, outputTokens: 40 }, model: "opus" },
    } as unknown as UIMessage
    setLive([msg("u1", "user"), assistantWithUsage], [])
    const { result } = renderHook(() => useSessionReport("s1"))
    expect(result.current.report?.turns).toBe(1)
    expect(result.current.report?.totalInputTokens).toBe(100)
    expect(result.current.report?.totalOutputTokens).toBe(40)
  })
})
