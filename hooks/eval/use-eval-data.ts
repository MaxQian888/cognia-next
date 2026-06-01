"use client"

/**
 * Live-query hooks for the eval dashboard. Thin wrappers over the Dexie CRUD
 * modules via `useLiveQuery` so the UI re-renders whenever datasets, runs, or
 * annotations change.
 */

import { useLiveQuery } from "dexie-react-hooks"
import { listDatasets, listCases } from "@/lib/db/eval-datasets"
import { listRunsByDataset } from "@/lib/db/eval-runs"
import { listAnnotations } from "@/lib/db/trace-annotations"
import { queryRecent } from "@/lib/db/agent-traces"
import { summarizeTraces, type TraceSummary } from "@/lib/ai/eval/trace-summary"
import type { EvalCase, EvalDataset } from "@/types/eval/eval"
import type { EvalRunRow } from "@/lib/db/eval-runs"
import type { TraceAnnotationRow } from "@/lib/db/trace-annotations"

export function useEvalDatasets(): EvalDataset[] {
  return useLiveQuery(() => listDatasets(), [], [])
}

export function useEvalRuns(datasetId?: string): EvalRunRow[] {
  return useLiveQuery(
    () => (datasetId ? listRunsByDataset(datasetId) : Promise.resolve([])),
    [datasetId],
    []
  )
}

export function useEvalCases(datasetId?: string): EvalCase[] {
  return useLiveQuery(
    () => (datasetId ? listCases(datasetId) : Promise.resolve([])),
    [datasetId],
    []
  )
}

export function useTraceAnnotations(): TraceAnnotationRow[] {
  return useLiveQuery(() => listAnnotations(), [], [])
}

export function useRecentTraces(limit = 50): TraceSummary[] {
  return useLiveQuery(async () => summarizeTraces(await queryRecent(limit)), [limit], [])
}
