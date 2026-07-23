// Fixture builders for eval-component stories.
//
// Realistic rows for the eval subsystem: datasets, cases, run reports, and
// dataset version snapshots. `makeRun` mirrors the cast used in
// `runs-list.stories.tsx` (EvalRunRow = EvalReport, which has more fields than
// any single story needs).
import type { EvalCase, EvalDataset } from "@/types/eval/eval"
import type { EvalDatasetVersion } from "@/types/eval/version"
import type { EvalRunRow } from "@/lib/db/eval-runs"

const NOW = 1_717_400_000_000

export function makeDataset(over: Partial<EvalDataset> = {}): EvalDataset {
  return {
    id: "ds-1",
    name: "Tool-use regression suite",
    capability: "chat.tool-use",
    version: 4,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }
}

let caseSeq = 0
export function makeCase(over: Partial<EvalCase> = {}): EvalCase {
  caseSeq += 1
  return {
    id: `case-${caseSeq}`,
    datasetId: "ds-1",
    input: "Summarize the latest deployment failure and suggest a fix.",
    capability: "chat.tool-use",
    source: "handwritten",
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }
}

export function makeCases(count = 5): EvalCase[] {
  caseSeq = 0
  const caps = ["chat.tool-use", "rag.retrieval", "chat.response-quality"]
  const sources: EvalCase["source"][] = ["handwritten", "real-trace", "synthetic"]
  return Array.from({ length: count }, (_, i) =>
    makeCase({
      input: `Case ${i + 1}: ${i % 2 === 0 ? "diagnose the failing CI job" : "draft a release note"}`,
      capability: caps[i % caps.length],
      source: sources[i % sources.length],
      split: i % 3 === 0 ? "test" : "train",
      tags: i % 2 === 0 ? ["smoke", "tools"] : ["regression"],
    })
  )
}

export function makeRun(over: Partial<EvalRunRow>): EvalRunRow {
  return {
    runId: "run-1",
    datasetId: "ds-1",
    datasetVersion: 4,
    targetLabel: "claude-opus",
    k: 1,
    caseCount: 20,
    scorers: {},
    passAt1: 0.92,
    passHatK: 0.92,
    totalCostUsd: 0.48,
    avgLatencyMs: 1200,
    createdAt: NOW,
    ...over,
  } as EvalRunRow
}

export function makeRuns(): EvalRunRow[] {
  return [
    makeRun({ runId: "run-1", targetLabel: "claude-opus", passAt1: 0.95, totalCostUsd: 0.62 }),
    makeRun({
      runId: "run-2",
      targetLabel: "claude-sonnet",
      k: 3,
      passAt1: 0.88,
      passHatK: 0.97,
      totalCostUsd: 0.21,
    }),
    makeRun({ runId: "run-3", targetLabel: "gpt-baseline", passAt1: 0.71, totalCostUsd: 0.34 }),
  ]
}

export function makeVersion(over: Partial<EvalDatasetVersion> = {}): EvalDatasetVersion {
  return {
    id: "ver-1",
    datasetId: "ds-1",
    version: 3,
    caseIds: makeCases(6).map((c) => c.id),
    casesHash: "a1b2c3d4e5f60718",
    createdAt: NOW,
    ...over,
  }
}
