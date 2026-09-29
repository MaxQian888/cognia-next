import type { Memory } from "@/types/memory/memory"

const mockGetSettings = jest.fn()
const mockListMemories = jest.fn()
const mockTryBuildReader = jest.fn()
const mockLintMemories = jest.fn()

jest.mock("@/lib/db/settings", () => ({
  getSettings: (...a: unknown[]) => mockGetSettings(...a),
}))
jest.mock("@/lib/db/memories", () => ({
  listMemories: (...a: unknown[]) => mockListMemories(...a),
}))
jest.mock("@/lib/memory/runtime/build-deps", () => ({
  tryBuildMemoryVectorReader: (...a: unknown[]) => mockTryBuildReader(...a),
}))
jest.mock("@cognia/memory/lint/memory-lint", () => {
  const actual = jest.requireActual("@cognia/memory/lint/memory-lint")
  return {
    ...actual,
    lintMemories: (...a: unknown[]) => {
      mockLintMemories(...a)
      return (actual.lintMemories as (...args: unknown[]) => unknown)(...a)
    },
  }
})

import { runMemoryLint } from "./run-memory-lint"

const NOW = 1_700_000_000_000

function mem(over: Partial<Memory> = {}): Memory {
  return {
    id: "m1",
    scope: "global",
    type: "semantic",
    text: "x",
    tags: [],
    importance: 5,
    createdAt: NOW,
    updatedAt: NOW,
    lastAccessedAt: NOW,
    accessCount: 0,
    version: 1,
    status: "active",
    pinned: false,
    provenance: "user",
    ...over,
  }
}

function lintArgs(): [Memory[], Record<string, unknown>] {
  return mockLintMemories.mock.calls[mockLintMemories.mock.calls.length - 1] as [
    Memory[],
    Record<string, unknown>,
  ]
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGetSettings.mockResolvedValue({ memory: {} })
  mockListMemories.mockResolvedValue([])
  mockTryBuildReader.mockResolvedValue(undefined)
})

describe("runMemoryLint", () => {
  it("loads active rows when none are passed and reports scanned count", async () => {
    mockListMemories.mockResolvedValue([mem({ id: "a" }), mem({ id: "b" })])
    const report = await runMemoryLint({ now: NOW })
    expect(mockListMemories).toHaveBeenCalledWith({ status: "active" })
    expect(report.scanned).toBe(2)
    expect(Array.isArray(report.findings)).toBe(true)
  })

  it("filters revision snapshots and non-active rows before linting", async () => {
    const report = await runMemoryLint({
      now: NOW,
      memories: [
        mem({ id: "live" }),
        mem({ id: "snap", revisionOf: "live" }),
        mem({ id: "dead", status: "invalidated" }),
      ],
    })
    expect(mockListMemories).not.toHaveBeenCalled()
    expect(report.scanned).toBe(1)
    expect(lintArgs()[0].map((m) => m.id)).toEqual(["live"])
  })

  it("uses the vector reader and reports contradictionCheck=ran", async () => {
    const getEmbeddings = jest.fn(
      async () =>
        new Map<string, number[]>([
          ["a", [1, 0]],
          ["b", [0, 1]],
        ])
    )
    mockTryBuildReader.mockResolvedValue({ getEmbeddings })
    const report = await runMemoryLint({
      now: NOW,
      memories: [
        mem({ id: "a", accessCount: 5 }),
        mem({ id: "b", type: "procedural", accessCount: 1 }),
        mem({ id: "c", type: "episodic" }),
        mem({ id: "s", revisionOf: "a" }),
      ],
    })
    expect(report.contradictionCheck).toBe("ran")
    // Durable rows only (semantic/procedural), coldest first, no snapshot.
    const passed = (getEmbeddings.mock.calls[0] as unknown as [Memory[]])[0]
    expect(passed.map((m) => m.id)).toEqual(["b", "a"])
    expect(lintArgs()[1].embeddings).toBeInstanceOf(Map)
  })

  it("reports no_vectors when no reader is available", async () => {
    const report = await runMemoryLint({
      now: NOW,
      memories: [mem({ id: "a" }), mem({ id: "b" })],
    })
    expect(mockTryBuildReader).toHaveBeenCalledTimes(1)
    expect(report.contradictionCheck).toBe("no_vectors")
    expect(lintArgs()[1]).not.toHaveProperty("embeddings")
  })

  it("reports no_vectors when fewer than two durable rows exist", async () => {
    const getEmbeddings = jest.fn()
    mockTryBuildReader.mockResolvedValue({ getEmbeddings })
    const report = await runMemoryLint({ now: NOW, memories: [mem({ id: "a" })] })
    expect(getEmbeddings).not.toHaveBeenCalled()
    expect(report.contradictionCheck).toBe("no_vectors")
  })

  it("reports no_vectors when the reader throws or returns fewer than two vectors", async () => {
    mockTryBuildReader.mockResolvedValue({
      getEmbeddings: jest.fn(async () => {
        throw new Error("boom")
      }),
    })
    const memories = [mem({ id: "a" }), mem({ id: "b" })]
    expect((await runMemoryLint({ now: NOW, memories })).contradictionCheck).toBe("no_vectors")

    mockTryBuildReader.mockResolvedValue({
      getEmbeddings: jest.fn(async () => new Map([["a", [1]]])),
    })
    expect((await runMemoryLint({ now: NOW, memories })).contradictionCheck).toBe("no_vectors")
  })

  it("reports disabled and never builds a reader when memory is disabled", async () => {
    mockGetSettings.mockResolvedValue({ memory: { enabled: false } })
    const report = await runMemoryLint({ now: NOW, memories: [mem({ id: "a" }), mem({ id: "b" })] })
    expect(report.contradictionCheck).toBe("disabled")
    expect(mockTryBuildReader).not.toHaveBeenCalled()
  })

  it("reports disabled in temporary mode", async () => {
    mockGetSettings.mockResolvedValue({ memory: { temporary: true } })
    const report = await runMemoryLint({ now: NOW, memories: [mem({ id: "a" }), mem({ id: "b" })] })
    expect(report.contradictionCheck).toBe("disabled")
    expect(mockTryBuildReader).not.toHaveBeenCalled()
  })

  it("falls back to default config when settings fail to load", async () => {
    mockGetSettings.mockRejectedValue(new Error("db down"))
    const report = await runMemoryLint({ now: NOW, memories: [mem({ id: "a" })] })
    expect(report.scanned).toBe(1)
    expect(report.contradictionCheck).toBe("no_vectors")
  })

  it("forwards retention knobs and now to the linter", async () => {
    mockGetSettings.mockResolvedValue({
      memory: { accessReinforcementWeight: 0.7, coldRetentionThreshold: 0.3 },
    })
    await runMemoryLint({ now: NOW, memories: [mem()] })
    expect(lintArgs()[1]).toEqual(
      expect.objectContaining({ now: NOW, retention: { sigma: 0.7 }, coldThreshold: 0.3 })
    )
  })
})
