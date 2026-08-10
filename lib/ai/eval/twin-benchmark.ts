import type { DecisionRecord, Playbook, StyleSample, TwinProfile } from "@/types/twin"
import { bulkAddCases, createDataset, type AddCaseInput } from "@/lib/db/eval-datasets"
import { getTwinProfile } from "@/lib/db/twin-profile"
import { getTwinChunksByIds } from "@/lib/db/twin-chunks"
import { getTwin } from "@/lib/db/twins"

const MAX_PER_KIND = 10
const CAPABILITY = "twin.identity"

type BenchmarkCase = AddCaseInput

function decisionCase(decision: DecisionRecord): BenchmarkCase {
  return {
    input: `In this situation, what would you choose and why?\n\n${decision.context}`,
    reference: {
      expectedContains: [decision.choice, decision.rationale].filter(Boolean),
      grading: { mode: "contains-any" },
    },
    capability: CAPABILITY,
    source: "synthetic",
    tags: ["twin", "decision"],
    metadata: {
      twinBenchmarkKind: "decision",
      decisionId: decision.id,
      sourceChunkIds: decision.sourceChunkIds,
    },
  }
}

function styleCase(sample: StyleSample, contentRedacted?: string): BenchmarkCase {
  const expected = contentRedacted?.trim() || sample.summary.trim()
  return {
    input: `Continue in the same voice for this context: ${sample.contextLabel}\n\nWrite a concise response that matches the twin's established style.`,
    reference: {
      expectedOutput: expected,
      ...(contentRedacted ? { expectedContext: [contentRedacted] } : {}),
    },
    capability: CAPABILITY,
    source: "synthetic",
    tags: ["twin", "style"],
    metadata: {
      twinBenchmarkKind: "style",
      styleSampleId: sample.id,
      sourceChunkIds: [sample.sourceChunkId],
      tone: sample.tone,
    },
  }
}

function playbookCase(playbook: Playbook): BenchmarkCase {
  const expectedContains = playbook.steps
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((step) => step.action)
  return {
    input: `A situation matches this trigger: ${playbook.trigger}\n\nExplain what you would do, then critique the approach and its trade-offs.`,
    reference: {
      expectedContains,
      grading: { mode: "contains-any" },
    },
    capability: CAPABILITY,
    source: "synthetic",
    tags: ["twin", "playbook"],
    metadata: {
      twinBenchmarkKind: "playbook",
      playbookId: playbook.id,
      sourceChunkIds: playbook.examples.flatMap((example) => example.sourceChunkIds),
    },
  }
}

export function buildTwinBenchmarkCases(
  profile: TwinProfile,
  redactedChunkText: ReadonlyMap<string, string> = new Map()
): BenchmarkCase[] {
  const decisions = profile.decisions.slice(0, MAX_PER_KIND).map(decisionCase)
  const styles = profile.styleSamples
    .slice(0, MAX_PER_KIND)
    .map((sample) => styleCase(sample, redactedChunkText.get(sample.sourceChunkId)))
  const playbooks = profile.playbooks.slice(0, MAX_PER_KIND).map(playbookCase)
  return [...decisions, ...styles, ...playbooks].slice(0, 30)
}

export interface CreateTwinBenchmarkResult {
  datasetId: string
  caseCount: number
}

/** Create an ordinary editable Eval dataset from the current Twin profile. */
export async function createTwinBenchmark(twinId: string): Promise<CreateTwinBenchmarkResult> {
  const [twin, profile] = await Promise.all([getTwin(twinId), getTwinProfile(twinId)])
  if (!twin) throw new Error(`Twin "${twinId}" not found`)
  if (!profile) throw new Error(`Twin "${twinId}" has no distilled profile`)

  const sourceChunkIds = new Set([
    ...profile.styleSamples.map((sample) => sample.sourceChunkId),
    ...profile.decisions.flatMap((decision) => decision.sourceChunkIds),
    ...profile.playbooks.flatMap((playbook) =>
      playbook.examples.flatMap((example) => example.sourceChunkIds)
    ),
  ])
  const chunks = await getTwinChunksByIds([...sourceChunkIds])
  const redactedChunkText = new Map(chunks.map((chunk) => [chunk.id, chunk.contentRedacted]))
  const cases = buildTwinBenchmarkCases(profile, redactedChunkText)
  if (cases.length === 0) throw new Error(`Twin "${twinId}" has no benchmarkable profile data`)

  const dataset = await createDataset({
    name: `${twin.name} Twin Benchmark`,
    description: `Editable benchmark generated from the current profile of ${twin.name}.`,
    capability: CAPABILITY,
  })
  await bulkAddCases(dataset.id, cases)
  return { datasetId: dataset.id, caseCount: cases.length }
}
