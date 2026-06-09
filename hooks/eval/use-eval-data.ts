"use client"

/**
 * Live-query hooks for the eval dashboard. Thin wrappers over the Dexie CRUD
 * modules via `useLiveQuery` so the UI re-renders whenever datasets, runs, or
 * annotations change.
 */

import { useLiveQuery } from "dexie-react-hooks"
import { listDatasets, listCases } from "@/lib/db/eval-datasets"
import { listRunsByDataset, listRecentRuns } from "@/lib/db/eval-runs"
import { listVersions } from "@/lib/db/eval-dataset-versions"
import { listCaseResults } from "@/lib/db/eval-run-cases"
import { listAnnotations } from "@/lib/db/trace-annotations"
import {
  listCalibrationSets,
  listItemsBySet,
  type CalibrationItemRow,
  type CalibrationSetSummary,
} from "@/lib/db/calibration-items"
import { listRunsBySet, type CalibrationRunRow } from "@/lib/db/calibration-runs"
import { queryRecent } from "@/lib/db/agent-traces"
import { summarizeTraces, type TraceSummary } from "@/lib/ai/eval/trace-summary"
import type { EvalCase, EvalDataset } from "@/types/eval/eval"
import type { EvalDatasetVersion } from "@/types/eval/version"
import type { EvalRunRow } from "@/lib/db/eval-runs"
import type { EvalRunCaseRow } from "@/lib/db/eval-run-cases"
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

export function useEvalDatasetVersions(datasetId?: string): EvalDatasetVersion[] {
  return useLiveQuery(
    () => (datasetId ? listVersions(datasetId) : Promise.resolve([])),
    [datasetId],
    []
  )
}

export function useEvalRunCaseResults(runId?: string): EvalRunCaseRow[] {
  return useLiveQuery(() => (runId ? listCaseResults(runId) : Promise.resolve([])), [runId], [])
}

export function useRecentRuns(limit = 50): EvalRunRow[] {
  return useLiveQuery(() => listRecentRuns(limit), [limit], [])
}

// — Judge calibration (eval spec §10) —

export function useCalibrationSets(): CalibrationSetSummary[] {
  return useLiveQuery(() => listCalibrationSets(), [], [])
}

export function useCalibrationItems(setId?: string): CalibrationItemRow[] {
  return useLiveQuery(() => (setId ? listItemsBySet(setId) : Promise.resolve([])), [setId], [])
}

export function useCalibrationRuns(setId?: string): CalibrationRunRow[] {
  return useLiveQuery(() => (setId ? listRunsBySet(setId) : Promise.resolve([])), [setId], [])
}

export function useLatestCalibrationRun(setId?: string): CalibrationRunRow | undefined {
  return useLiveQuery(
    async () => (setId ? (await listRunsBySet(setId))[0] : undefined),
    [setId],
    undefined
  )
}
