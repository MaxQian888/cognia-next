/**
 * Shared builders for the Harness Evolution tests (ADR-0237). Test-only: no
 * production module imports this file.
 */

import type {
  HarnessEvolutionRun,
  HarnessEvolutionRunConfig,
  HarnessEvolutionStep,
  HarnessEvolutionTask,
  HarnessExecutionEvidence,
} from "@/types/harness/evolution"
import type { HarnessExperience } from "@/types/harness/experience"
import type {
  HarnessComponentsV1,
  HarnessSkillV1,
  HarnessSnapshotV1,
} from "@/types/harness/snapshot"
import { DEFAULT_HARNESS_BUDGET, emptyLedger } from "./budget"

export function makeSkill(overrides: Partial<HarnessSkillV1> = {}): HarnessSkillV1 {
  return {
    key: "csv-report",
    name: "csv-report",
    description: "Summarise a CSV file into a markdown report.",
    content: "1. Read the CSV.\n2. Run `scripts/summarize.py data.csv`.\n3. Write report.md.",
    resources: [
      {
        path: "scripts/summarize.py",
        kind: "script",
        content: "import csv, sys\nprint(sum(1 for _ in csv.reader(open(sys.argv[1]))))\n",
        encoding: "utf-8",
      },
    ],
    ...overrides,
  }
}

export function makeComponents(overrides: Partial<HarnessComponentsV1> = {}): HarnessComponentsV1 {
  return {
    systemPrompt: "You are a careful analyst. Answer with evidence.",
    guardrails: "Never invent numbers.",
    memory: "Reports go in report.md.",
    toolGuidance: "Prefer Read over Bash for viewing files.",
    skills: [makeSkill()],
    subagents: [
      {
        name: "checker",
        description: "Re-checks a finished report against the data.",
        prompt: "Open report.md and the CSV and list any number that does not match.",
        tools: ["Read"],
      },
    ],
    toolRules: [
      { id: "bash-cap", kind: "call-cap", tool: "Bash", maxCalls: 20, reason: "Stop looping." },
    ],
    ...overrides,
  }
}

export function makeTask(overrides: Partial<HarnessEvolutionTask> = {}): HarnessEvolutionTask {
  return {
    title: "CSV report",
    prompt: "Summarise data.csv into report.md.",
    domain: "office/reports",
    isolation: "files",
    expectedDeliverables: ["report.md"],
    checks: [{ kind: "deliverable-file", path: "report.md" }],
    source: { kind: "custom" },
    inputHash: "task-hash",
    ...overrides,
  }
}

export function makeRunConfig(
  overrides: Partial<HarnessEvolutionRunConfig> = {}
): HarnessEvolutionRunConfig {
  return {
    mode: "parallel",
    k: 1,
    scope: "task",
    editable: ["systemPrompt", "guardrails", "memory", "toolGuidance", "skills"],
    models: {},
    budget: { ...DEFAULT_HARNESS_BUDGET },
    autoAdoptLowRisk: false,
    useExperiences: true,
    editorChannel: "structured",
    probe: { allowedMcpServerIds: [], networkOff: false },
    seed: 7,
    ...overrides,
  }
}

export function makeRun(overrides: Partial<HarnessEvolutionRun> = {}): HarnessEvolutionRun {
  return {
    id: "run-1",
    characterId: "agent-1",
    characterName: "Analyst",
    trigger: "manual",
    task: makeTask(),
    config: makeRunConfig(),
    status: "queued",
    round: 0,
    finalLabels: [],
    experienceIds: [],
    ledger: emptyLedger(),
    dedupeKey: "hrd1-x",
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

export function makeEvidence(
  overrides: Partial<HarnessExecutionEvidence> = {}
): HarnessExecutionEvidence {
  return {
    snapshotId: "snap-base",
    inputFingerprint: "task-hash",
    environmentFingerprint: "hef1-env",
    output: "Wrote report.md",
    trajectory: '[ACTION] Write {"file_path":"report.md"}\n[OBSERVATION] ok',
    deliverables: [{ path: "report.md", bytes: 8, text: "# Report" }],
    metrics: {
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 0,
      costUsd: 0.01,
      latencyMs: 5000,
      toolCalls: 3,
      toolFailures: 0,
      steps: 3,
    },
    validation: [{ check: "deliverable report.md", passed: true, status: "passed" }],
    blockedActions: [],
    delegations: [],
    degraded: false,
    delivered: true,
    ...overrides,
  }
}

export function makeExperience(overrides: Partial<HarnessExperience> = {}): HarnessExperience {
  return {
    id: "exp-1",
    scope: "agent",
    characterId: "agent-1",
    domain: "office/reports",
    problemPattern: "CSV inputs use semicolon separators and the agent parses them as commas",
    lesson: "memory.md: state that CSV files may use ; and to check the header first",
    evidenceSummary: "base1 misparsed data.csv; dom1 with the note parsed it",
    confidence: "medium",
    applicableConditions: ["csv input"],
    excludedConditions: ["excel files"],
    components: ["memory"],
    edits: [
      {
        component: "memory.md",
        candidates: ["dom1"],
        change: "note on separators",
        observed: "dom1 parsed the file",
        verdict: "helped",
      },
    ],
    baseSnapshotId: "snap-base",
    evidenceRefs: ["run-0:dom1"],
    sourceRunId: "run-0",
    changeSummary: "memory.md: note on separators (helped)",
    observedBenefits: ["dom1 parsed the file"],
    knownLimitations: [],
    validationStatus: "proposed",
    runtimeFingerprint: "hrf1-a",
    tags: ["csv"],
    supportRunIds: ["run-0"],
    conflictsWith: [],
    retrievedCount: 0,
    helpedCount: 0,
    hurtCount: 0,
    disabled: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

/** A step of run `run-1`, labelled `label` (`<runId>:<label>` id). */
export function makeStep(
  label: string,
  overrides: Partial<HarnessEvolutionStep> = {}
): HarnessEvolutionStep {
  const runId = overrides.runId ?? "run-1"
  return {
    id: `${runId}:${label}`,
    runId,
    label,
    kind: "rollout",
    status: "succeeded",
    attempts: 1,
    inputTokens: 100,
    outputTokens: 20,
    modelCalls: 0,
    updatedAt: 1,
    ...overrides,
  }
}

/** A captured snapshot of agent `agent-1`. */
export function makeSnapshot(overrides: Partial<HarnessSnapshotV1> = {}): HarnessSnapshotV1 {
  return {
    schemaVersion: 1,
    id: "snap-base",
    contentHash: "hash-base",
    characterId: "agent-1",
    characterName: "Analyst",
    scope: "task",
    components: makeComponents(),
    execution: {},
    runtimeFingerprint: "hrf1-a",
    origin: { kind: "captured" },
    createdAt: 1,
    ...overrides,
  }
}
