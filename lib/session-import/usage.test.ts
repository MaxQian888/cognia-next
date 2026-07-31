import {
  deriveImportedUsageRows,
  hasImportedUsage,
  importedUsageMetadata,
  type ImportedMessageLike,
} from "./usage"

const asst = (id: string, meta?: unknown, createdAt = 100): ImportedMessageLike => ({
  id,
  sessionId: "s",
  role: "assistant",
  createdAt,
  metadata: meta as ImportedMessageLike["metadata"],
})

describe("importedUsageMetadata", () => {
  it("wraps usage + model, omitting model when absent", () => {
    expect(importedUsageMetadata({ inputTokens: 1 }, "m")).toEqual({
      usage: { inputTokens: 1 },
      model: "m",
    })
    expect(importedUsageMetadata({ inputTokens: 1 })).toEqual({ usage: { inputTokens: 1 } })
  })
})

describe("deriveImportedUsageRows", () => {
  it("builds rows from assistant metadata.usage, honoring per-message + fallback model", () => {
    const messages: ImportedMessageLike[] = [
      { id: "u", sessionId: "s", role: "user", createdAt: 1 },
      asst(
        "a1",
        importedUsageMetadata(
          {
            inputTokens: 100,
            outputTokens: 40,
            cacheReadInputTokens: 200,
            cacheCreationInputTokens: 5,
            totalCostUsd: 0.02,
            durationMs: 500,
          },
          "opus"
        ),
        10
      ),
      asst("a2", importedUsageMetadata({ inputTokens: 10 }), 20),
    ]
    const rows = deriveImportedUsageRows(messages, { fallbackModel: "fallback" })
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      messageId: "a1",
      sessionId: "s",
      at: 10,
      model: "opus",
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 200,
      cacheCreationTokens: 5,
      costUsd: 0.02,
      durationMs: 500,
    })
    // No per-message model → session fallback.
    expect(rows[1].model).toBe("fallback")
  })

  it("skips users, systems, and assistants without usage", () => {
    const rows = deriveImportedUsageRows([
      { id: "u", role: "user", metadata: importedUsageMetadata({ inputTokens: 5 }) },
      asst("a", undefined),
      { id: "sys", role: "system" },
    ])
    expect(rows).toEqual([])
  })

  it("defaults missing token fields to 0", () => {
    const rows = deriveImportedUsageRows([asst("a", { usage: {} })])
    expect(rows[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      durationMs: 0,
    })
  })
})

describe("hasImportedUsage", () => {
  it("is true only when an assistant carries usage", () => {
    expect(hasImportedUsage([asst("a", importedUsageMetadata({ inputTokens: 1 }))])).toBe(true)
    expect(hasImportedUsage([asst("a", undefined)])).toBe(false)
  })
})
