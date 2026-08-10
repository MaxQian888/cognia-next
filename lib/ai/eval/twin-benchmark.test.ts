import type { TwinProfile } from "@/types/twin"

jest.mock("@/lib/db/eval-datasets", () => ({
  createDataset: jest.fn(async () => ({ id: "dataset-1" })),
  bulkAddCases: jest.fn(async () => ({ added: 3, updated: 0 })),
}))
jest.mock("@/lib/db/twin-profile", () => ({ getTwinProfile: jest.fn() }))
jest.mock("@/lib/db/twin-chunks", () => ({ getTwinChunksByIds: jest.fn(async () => []) }))
jest.mock("@/lib/db/twins", () => ({ getTwin: jest.fn() }))

import { buildTwinBenchmarkCases, createTwinBenchmark } from "./twin-benchmark"
import { bulkAddCases, createDataset } from "@/lib/db/eval-datasets"
import { getTwinProfile } from "@/lib/db/twin-profile"
import { getTwinChunksByIds } from "@/lib/db/twin-chunks"
import { getTwin } from "@/lib/db/twins"

function profile(): TwinProfile {
  return {
    id: "t1",
    twinId: "t1",
    voiceSummary: "concise",
    updatedAt: 1,
    entities: [],
    decisions: Array.from({ length: 12 }, (_, i) => ({
      id: `d${i}`,
      context: `context ${i}`,
      choice: `choice ${i}`,
      rationale: `reason ${i}`,
      sourceChunkIds: [`dc${i}`],
    })),
    styleSamples: Array.from({ length: 12 }, (_, i) => ({
      id: `s${i}`,
      contextLabel: `context ${i}`,
      original: `private original ${i}`,
      summary: `summary ${i}`,
      sourceChunkId: `sc${i}`,
      tone: ["concise"],
      addedAt: i,
      addedBy: "distill" as const,
    })),
    playbooks: Array.from({ length: 12 }, (_, i) => ({
      id: `p${i}`,
      title: `playbook ${i}`,
      trigger: `trigger ${i}`,
      steps: [{ order: 1, action: `step ${i}` }],
      examples: [{ sourceChunkIds: [`pc${i}`], outcome: "ok" }],
      confidence: 0.8,
    })),
  }
}

describe("buildTwinBenchmarkCases", () => {
  it("builds at most ten editable cases for each existing benchmark kind", () => {
    const cases = buildTwinBenchmarkCases(profile(), new Map([["sc0", "safe style text"]]))
    expect(cases).toHaveLength(30)
    expect(cases.filter((row) => row.tags?.includes("decision"))).toHaveLength(10)
    expect(cases.filter((row) => row.tags?.includes("style"))).toHaveLength(10)
    expect(cases.filter((row) => row.tags?.includes("playbook"))).toHaveLength(10)
  })

  it("uses locally redacted chunk text and never copies the style original", () => {
    const cases = buildTwinBenchmarkCases(profile(), new Map([["sc0", "safe style text"]]))
    const style = cases.find((row) => row.metadata?.styleSampleId === "s0")
    expect(style?.reference?.expectedOutput).toBe("safe style text")
    expect(JSON.stringify(cases)).not.toContain("private original")
    expect(style?.metadata?.sourceChunkIds).toEqual(["sc0"])
  })

  it("writes the generated cases into the existing editable Eval dataset tables", async () => {
    jest.mocked(getTwin).mockResolvedValue({ id: "t1", name: "Alice" } as never)
    jest.mocked(getTwinProfile).mockResolvedValue(profile())
    jest
      .mocked(getTwinChunksByIds)
      .mockResolvedValue([{ id: "sc0", contentRedacted: "safe style text" } as never])

    await expect(createTwinBenchmark("t1")).resolves.toEqual({
      datasetId: "dataset-1",
      caseCount: 30,
    })
    expect(createDataset).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "twin.identity", name: "Alice Twin Benchmark" })
    )
    expect(bulkAddCases).toHaveBeenCalledWith("dataset-1", expect.any(Array))
  })

  it("rejects a Twin without benchmarkable profile data", async () => {
    jest.mocked(getTwin).mockResolvedValue({ id: "empty", name: "Empty" } as never)
    jest.mocked(getTwinProfile).mockResolvedValue({
      ...profile(),
      id: "empty",
      twinId: "empty",
      decisions: [],
      styleSamples: [],
      playbooks: [],
    })
    await expect(createTwinBenchmark("empty")).rejects.toThrow(/no benchmarkable/i)
  })

  it("rejects missing Twin registry and profile rows explicitly", async () => {
    jest.mocked(getTwin).mockResolvedValueOnce(undefined)
    jest.mocked(getTwinProfile).mockResolvedValueOnce(profile())
    await expect(createTwinBenchmark("missing")).rejects.toThrow(/not found/i)

    jest.mocked(getTwin).mockResolvedValueOnce({ id: "t1", name: "Alice" } as never)
    jest.mocked(getTwinProfile).mockResolvedValueOnce(undefined)
    await expect(createTwinBenchmark("t1")).rejects.toThrow(/no distilled profile/i)
  })
})
