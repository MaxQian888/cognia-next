/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

// useLiveQuery mock invokes the querier synchronously and returns its result,
// so the querier closures (and their branches) are exercised.
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (querier: () => unknown) => querier(),
}))
jest.mock("@/lib/db/eval-datasets", () => ({
  listDatasets: jest.fn(() => ["ds"]),
  listCases: jest.fn((id: string) => [`case-${id}`]),
}))
jest.mock("@/lib/db/eval-runs", () => ({
  listRunsByDataset: jest.fn((id: string) => [`run-${id}`]),
  listRecentRuns: jest.fn((limit: number) => [`recent-${limit}`]),
}))
jest.mock("@/lib/db/eval-dataset-versions", () => ({
  listVersions: jest.fn((id: string) => [`ver-${id}`]),
}))
jest.mock("@/lib/db/eval-run-cases", () => ({
  listCaseResults: jest.fn((id: string) => [`caseres-${id}`]),
}))
jest.mock("@/lib/db/trace-annotations", () => ({
  listAnnotations: jest.fn(() => ["ann"]),
}))
jest.mock("@/lib/db/calibration-items", () => ({
  listCalibrationSets: jest.fn(() => ["set-summary"]),
  listItemsBySet: jest.fn((id: string) => [`item-${id}`]),
}))
jest.mock("@/lib/db/calibration-runs", () => ({
  listRunsBySet: jest.fn((id: string) => [`calrun-${id}`, `calrun-${id}-older`]),
}))
jest.mock("@/lib/db/agent-traces", () => ({
  queryRecentTraces: jest.fn(async () => [
    { traceId: "t", sessionId: "s", startTime: 1, operationName: "chat" },
  ]),
  countTraces: jest.fn(async () => 7),
}))
jest.mock("@/lib/ai/eval/trace-prompt", () => ({
  defaultPromptLoader: () => async () => [],
  resolveTracePrompts: jest.fn(async () => ({ t: "the original prompt" })),
}))

import {
  useEvalDatasets,
  useEvalRuns,
  useEvalCases,
  useTraceAnnotations,
  useRecentTraces,
  useEvalDatasetVersions,
  useEvalRunCaseResults,
  useRecentRuns,
  useCalibrationSets,
  useCalibrationItems,
  useCalibrationRuns,
  useLatestCalibrationRun,
  useTraceCount,
  useTracePrompts,
} from "./use-eval-data"
import { queryRecentTraces } from "@/lib/db/agent-traces"
import { listRunsByDataset } from "@/lib/db/eval-runs"
import { listCases } from "@/lib/db/eval-datasets"
import { listItemsBySet } from "@/lib/db/calibration-items"
import { listRunsBySet } from "@/lib/db/calibration-runs"
import { listVersions } from "@/lib/db/eval-dataset-versions"
import { listCaseResults } from "@/lib/db/eval-run-cases"

describe("use-eval-data hooks", () => {
  it("useEvalDatasets reads the dataset list", () => {
    const { result } = renderHook(() => useEvalDatasets())
    expect(result.current).toEqual(["ds"])
  })

  it("useEvalRuns queries by dataset id when given", () => {
    const { result } = renderHook(() => useEvalRuns("d1"))
    expect(result.current).toEqual(["run-d1"])
    expect(listRunsByDataset).toHaveBeenCalledWith("d1")
  })

  it("useEvalRuns returns an empty list without a dataset id", async () => {
    const { result } = renderHook(() => useEvalRuns(undefined))
    await expect(result.current as unknown as Promise<unknown[]>).resolves.toEqual([])
  })

  it("useEvalCases queries by dataset id when given", () => {
    const { result } = renderHook(() => useEvalCases("d2"))
    expect(result.current).toEqual(["case-d2"])
    expect(listCases).toHaveBeenCalledWith("d2")
  })

  it("useEvalCases returns an empty list without a dataset id", async () => {
    const { result } = renderHook(() => useEvalCases())
    await expect(result.current as unknown as Promise<unknown[]>).resolves.toEqual([])
  })

  it("useTraceAnnotations reads the annotation list", () => {
    const { result } = renderHook(() => useTraceAnnotations())
    expect(result.current).toEqual(["ann"])
  })

  it("useRecentTraces summarizes recent spans, paging by TRACE", async () => {
    // It used to call `queryRecent`, which counts SPANS — so "50 traces" was
    // however few traces the last 50 spans covered.
    const { result } = renderHook(() => useRecentTraces(10, 20))
    const summaries = (await result.current) as unknown as { traceId: string }[]
    expect(summaries[0].traceId).toBe("t")
    expect(queryRecentTraces).toHaveBeenCalledWith(10, 20)
  })

  it("useRecentTraces defaults to the first page", async () => {
    renderHook(() => useRecentTraces())
    expect(queryRecentTraces).toHaveBeenCalledWith(50, 0)
  })

  it("useTraceCount reports the distinct trace total", async () => {
    const { result } = renderHook(() => useTraceCount())
    await expect(result.current as unknown as Promise<number>).resolves.toBe(7)
  })

  it("useTracePrompts resolves original prompts keyed by trace id", async () => {
    const { result } = renderHook(() =>
      useTracePrompts([
        { traceId: "t", sessionId: "s", startTime: 1, toolNames: [], preview: "clipped…" },
      ])
    )
    await expect(result.current as unknown as Promise<Record<string, string>>).resolves.toEqual({
      t: "the original prompt",
    })
  })

  it("useEvalDatasetVersions queries by dataset id when given", () => {
    const { result } = renderHook(() => useEvalDatasetVersions("d3"))
    expect(result.current).toEqual(["ver-d3"])
    expect(listVersions).toHaveBeenCalledWith("d3")
  })

  it("useEvalDatasetVersions returns empty without an id", async () => {
    const { result } = renderHook(() => useEvalDatasetVersions())
    await expect(result.current as unknown as Promise<unknown[]>).resolves.toEqual([])
  })

  it("useEvalRunCaseResults queries by run id when given", () => {
    const { result } = renderHook(() => useEvalRunCaseResults("run-7"))
    expect(result.current).toEqual(["caseres-run-7"])
    expect(listCaseResults).toHaveBeenCalledWith("run-7")
  })

  it("useEvalRunCaseResults returns empty without an id", async () => {
    const { result } = renderHook(() => useEvalRunCaseResults())
    await expect(result.current as unknown as Promise<unknown[]>).resolves.toEqual([])
  })

  it("useRecentRuns reads the recent runs list", () => {
    const { result } = renderHook(() => useRecentRuns(20))
    expect(result.current).toEqual(["recent-20"])
  })

  it("useCalibrationSets lists calibration sets", () => {
    const { result } = renderHook(() => useCalibrationSets())
    expect(result.current).toEqual(["set-summary"])
  })

  it("useCalibrationItems queries by set id when given", () => {
    const { result } = renderHook(() => useCalibrationItems("set-a"))
    expect(result.current).toEqual(["item-set-a"])
    expect(listItemsBySet).toHaveBeenCalledWith("set-a")
  })

  it("useCalibrationItems returns empty without a set id", async () => {
    const { result } = renderHook(() => useCalibrationItems())
    await expect(result.current as unknown as Promise<unknown[]>).resolves.toEqual([])
  })

  it("useCalibrationRuns queries by set id when given", () => {
    const { result } = renderHook(() => useCalibrationRuns("set-a"))
    expect(result.current).toEqual(["calrun-set-a", "calrun-set-a-older"])
    expect(listRunsBySet).toHaveBeenCalledWith("set-a")
  })

  it("useCalibrationRuns returns empty without a set id", async () => {
    const { result } = renderHook(() => useCalibrationRuns())
    await expect(result.current as unknown as Promise<unknown[]>).resolves.toEqual([])
  })

  it("useLatestCalibrationRun returns the newest run for a set", async () => {
    const { result } = renderHook(() => useLatestCalibrationRun("set-a"))
    await expect(result.current as unknown as Promise<unknown>).resolves.toBe("calrun-set-a")
  })

  it("useLatestCalibrationRun returns undefined without a set id", async () => {
    const { result } = renderHook(() => useLatestCalibrationRun())
    await expect(result.current as unknown as Promise<unknown>).resolves.toBeUndefined()
  })
})
