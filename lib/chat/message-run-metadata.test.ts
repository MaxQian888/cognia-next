import type { UIMessage } from "ai"
import {
  attachRunMetadataToLastAssistant,
  attachUsageToLastAssistant,
  buildCompletedRunMetadata,
  runMetadataOf,
} from "./message-run-metadata"

const messages = (): UIMessage[] => [
  { id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] },
  {
    id: "a1",
    role: "assistant",
    parts: [{ type: "text", text: "hi" }],
    metadata: { branchGroupId: "b1" },
  },
]

describe("assistant run metadata", () => {
  it("attaches an immutable run snapshot to the last assistant and preserves metadata", () => {
    const next = attachRunMetadataToLastAssistant(messages(), {
      providerId: "anthropic",
      modelId: "claude-sonnet-4-6",
      startedAt: 100,
      completedAt: 250,
      durationMs: 150,
      finishReason: "success",
    })

    expect(next[1].metadata).toEqual({
      branchGroupId: "b1",
      run: {
        providerId: "anthropic",
        modelId: "claude-sonnet-4-6",
        startedAt: 100,
        completedAt: 250,
        durationMs: 150,
        finishReason: "success",
      },
    })
    expect(messages()[1].metadata).toEqual({ branchGroupId: "b1" })
  })

  it("does not invent unavailable fields or modify an imported message", () => {
    const imported = messages()
    expect(runMetadataOf(imported[1])).toBeUndefined()
    expect(attachRunMetadataToLastAssistant(imported, {})).toBe(imported)
  })

  it("prefers a provider-reported duration and preserves partially reported fields", () => {
    expect(
      buildCompletedRunMetadata({
        providerId: "external",
        completedAt: 500,
        reportedDurationMs: 42,
      })
    ).toEqual({
      providerId: "external",
      modelId: undefined,
      startedAt: undefined,
      completedAt: 500,
      durationMs: 42,
      finishReason: undefined,
    })
  })

  it("derives duration only when start time is known and never guesses model attribution", () => {
    expect(buildCompletedRunMetadata({ startedAt: 100, completedAt: 250 })).toMatchObject({
      startedAt: 100,
      completedAt: 250,
      durationMs: 150,
    })
    expect(buildCompletedRunMetadata({ completedAt: 250 })).toEqual({
      providerId: undefined,
      modelId: undefined,
      startedAt: undefined,
      completedAt: 250,
      durationMs: undefined,
      finishReason: undefined,
    })
  })

  it("merges partial updates and leaves inputs without an assistant untouched", () => {
    const existing = messages()
    existing[1] = { ...existing[1], metadata: { run: { startedAt: 100 } } }
    const merged = attachRunMetadataToLastAssistant(existing, { completedAt: 200 })
    expect(runMetadataOf(merged[1])).toEqual({ startedAt: 100, completedAt: 200 })

    const userOnly = [messages()[0]]
    expect(attachRunMetadataToLastAssistant(userOnly, { completedAt: 200 })).toBe(userOnly)
  })
})

describe("attachUsageToLastAssistant", () => {
  const usageOf = (list: UIMessage[]) =>
    (list[1].metadata as { usage?: Record<string, unknown> }).usage

  it("stamps the turn's tokens on the newest assistant without losing its metadata", () => {
    const next = attachUsageToLastAssistant(messages(), {
      inputTokens: 120,
      contextTokens: 41_000,
      contextWindow: 272_000,
    })
    expect(usageOf(next)).toEqual({
      inputTokens: 120,
      contextTokens: 41_000,
      contextWindow: 272_000,
    })
    expect((next[1].metadata as { branchGroupId?: string }).branchGroupId).toBe("b1")
  })

  it("merges into an existing usage object instead of replacing it", () => {
    const seeded = messages()
    seeded[1] = {
      ...seeded[1],
      metadata: { ...(seeded[1].metadata as object), usage: { inputTokens: 5, outputTokens: 9 } },
    } as UIMessage
    expect(usageOf(attachUsageToLastAssistant(seeded, { outputTokens: 12 }))).toEqual({
      inputTokens: 5,
      outputTokens: 12,
    })
  })

  it("is a no-op for an empty patch or a transcript with no assistant", () => {
    const list = messages()
    expect(attachUsageToLastAssistant(list, {})).toBe(list)
    const userOnly: UIMessage[] = [{ id: "u1", role: "user", parts: [] }]
    expect(attachUsageToLastAssistant(userOnly, { inputTokens: 1 })).toBe(userOnly)
  })
})
