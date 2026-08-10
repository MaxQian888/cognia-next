import { createTwinTarget, hydrateTwinRetrievalSpans } from "./twin"

it("runs through Chat with an ephemeral Twin Character", async () => {
  const runTurn = jest.fn(async () => ({ text: "answer", sessionId: "eval-session" }))
  const target = createTwinTarget(
    { label: "Alice", twinId: "alice", providerId: "anthropic", model: "m" },
    {
      runTurn,
      fetchSpans: async () => [],
      cleanupSession: async () => undefined,
      isToolCapable: () => true,
    }
  )
  await expect(
    target.run({ id: "c1", datasetId: "d", input: "hello" } as never)
  ).resolves.toMatchObject({
    output: "answer",
  })
  expect(runTurn).toHaveBeenCalledWith(
    expect.objectContaining({
      model: "m",
      providerId: "anthropic",
      character: expect.objectContaining({ twinId: "alice" }),
    })
  )
})

it("hydrates redacted Twin chunks for scoring without mutating persisted spans", async () => {
  const span = {
    id: "span",
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    startTime: 1,
    operationName: "retrieval" as const,
    providerName: "cognia.twin" as const,
    sessionId: "eval",
    surface: "chat" as const,
    metadata: {
      twinId: "twin-1",
      chunkIds: ["chunk-1"],
      chunkScores: [0.8],
    },
  }
  const hydrated = await hydrateTwinRetrievalSpans([span], "twin-1", async () => [
    { id: "chunk-1", contentRedacted: "safe [EMAIL]" },
  ])
  expect(hydrated[0].metadata?.retrievedChunks).toEqual([
    { id: "chunk-1", text: "safe [EMAIL]", score: 0.8 },
  ])
  expect(span.metadata).not.toHaveProperty("retrievedChunks")
})

it("blocks unredacted PII before the Twin Eval chat path", async () => {
  const runTurn = jest.fn(async () => ({ text: "answer", sessionId: "eval-session" }))
  const target = createTwinTarget(
    { label: "Alice", twinId: "alice", model: "m" },
    {
      runTurn,
      fetchSpans: async () => [],
      isToolCapable: () => true,
    }
  )

  await expect(
    target.run({ id: "c1", datasetId: "d", input: "Email alice@example.com" } as never)
  ).rejects.toThrow("unredacted PII")
  expect(runTurn).not.toHaveBeenCalled()
})
