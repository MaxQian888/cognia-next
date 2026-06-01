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
}))
jest.mock("@/lib/db/trace-annotations", () => ({
  listAnnotations: jest.fn(() => ["ann"]),
}))
jest.mock("@/lib/db/agent-traces", () => ({
  queryRecent: jest.fn(async () => [
    { traceId: "t", sessionId: "s", startTime: 1, operationName: "chat" },
  ]),
}))

import {
  useEvalDatasets,
  useEvalRuns,
  useEvalCases,
  useTraceAnnotations,
  useRecentTraces,
} from "./use-eval-data"
import { listRunsByDataset } from "@/lib/db/eval-runs"
import { listCases } from "@/lib/db/eval-datasets"

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

  it("useRecentTraces summarizes recent spans", async () => {
    const { result } = renderHook(() => useRecentTraces(10))
    const summaries = (await result.current) as unknown as { traceId: string }[]
    expect(summaries[0].traceId).toBe("t")
  })
})
