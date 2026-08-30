/** @jest-environment node */

/**
 * The acceptance test for moving the engine into `@cognia/eval-core`: the same
 * fixture, scored through the in-app path and through the CLI's checkpointed
 * loop, must produce the same report field for field.
 *
 * This is not a tautology just because both now call `deterministicScorers()`.
 * The two drivers are still separate — `runDatasetEval` scores inside
 * `runEval`, while the CLI scores per repetition around a reservation and a
 * checkpoint write — and it was exactly that second driver which used to carry
 * its own quality heuristic. This pins the two together so the next divergence
 * fails here instead of shipping a CI verdict that disagrees with the UI.
 */

import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  buildReport,
  deterministicScorers,
  repetitionVerdict,
  type EvalCase,
  type EvalCaseResult,
  type EvalDataset,
  type EvalSample,
} from "@cognia/eval-core"
import type { EvalProject } from "@cognia/eval-core"
import { GOLDEN_ENTRIES } from "@/lib/ai/eval/ci/golden-fixture"

const mockRunTarget = jest.fn()
jest.mock("@/lib/ai/eval/targets/model", () => ({
  createPureModelEvalTarget: () => ({ run: (...args: unknown[]) => mockRunTarget(...args) }),
}))

import { runDatasetEval } from "@/lib/ai/eval"
import { executeCliEvalProject, type CliEvalCheckpoint } from "./execute-project"

const CASES: EvalCase[] = GOLDEN_ENTRIES.map((entry) => entry.case)
const SAMPLE_BY_CASE = new Map<string, EvalSample>(
  GOLDEN_ENTRIES.map((entry) => [entry.case.id, entry.sample])
)

/** Replays the recorded trajectory so both paths score identical samples. */
function replay(evalCase: EvalCase): EvalSample {
  const sample = SAMPLE_BY_CASE.get(evalCase.id)
  if (!sample) throw new Error(`no recorded sample for ${evalCase.id}`)
  return sample
}

function dataset(): EvalDataset {
  return {
    id: "golden",
    name: "Golden",
    capability: "chat.tool-use",
    version: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

function project(): EvalProject {
  return {
    id: "parity",
    name: "Parity",
    mode: "model",
    dataset: {
      datasetId: "golden",
      version: 1,
      digest: "sha256:golden",
      caseIds: CASES.map((item) => item.id),
      holdoutCaseIds: [],
      requiredModalities: ["text"],
    },
    variants: [
      {
        id: "a",
        name: "a",
        kind: "model",
        providerId: "local",
        modelId: "model-a",
        runtimeTarget: "web",
        isLocal: true,
        capabilities: ["text"],
        available: true,
        credentialReady: true,
        runtimeReady: true,
      },
    ],
    decisionPolicy: {
      formal: false,
      dimensions: [{ metric: "quality", direction: "maximize", weight: 1 }],
      constraints: [],
      confidenceLevel: 0.95,
      minimumEffectiveCases: 1,
    },
    budget: { currency: "USD", hardCap: 1, confirmed: true },
    judgePolicy: { enabled: false, calibrated: false, anchorCount: 0, kappa: 0, accuracy: 0 },
    privacyPolicy: { cloudPiiMode: "redact", mediaClearance: "local-only" },
    retentionDays: 90,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe("browser ⇄ CLI scoring parity", () => {
  beforeEach(() => {
    mockRunTarget.mockReset()
    mockRunTarget.mockImplementation((evalCase: EvalCase) => Promise.resolve(replay(evalCase)))
  })

  it("produces the same report from the in-app path and the CLI checkpoint loop", async () => {
    // --- in-app path -------------------------------------------------------
    const app = await runDatasetEval({
      dataset: dataset(),
      cases: CASES,
      scorers: deterministicScorers(),
      target: { label: "a", run: async (evalCase) => replay(evalCase) },
      runId: "run-parity",
      now: 0,
    })

    // --- CLI path ----------------------------------------------------------
    const directory = await mkdtemp(path.join(tmpdir(), "cognia-parity-"))
    const result = await executeCliEvalProject(
      { project: project(), cases: CASES },
      path.join(directory, "checkpoint.json")
    )
    const checkpoint = result.checkpoint as CliEvalCheckpoint

    // Per-case observations must match exactly — same scorer ids, statuses,
    // values, and verdicts.
    for (const [index, evalCase] of CASES.entries()) {
      const cliRow = checkpoint.samples.find(
        (row) => row.caseId === evalCase.id && row.repetition === 1
      )
      const appRepetition = app.results[index].repetitions[0]
      expect(cliRow?.scores).toEqual(appRepetition.scores)
      expect(cliRow?.verdict).toBe(repetitionVerdict(appRepetition))
    }

    // And the aggregate the two would publish must be identical.
    const cliResults: EvalCaseResult[] = CASES.map((evalCase) => ({
      caseId: evalCase.id,
      repetitions: checkpoint.samples
        .filter((row) => row.caseId === evalCase.id && row.repetition === 1)
        .map((row) => ({ sample: replay(evalCase), scores: row.scores ?? [] })),
    }))
    const cliReport = buildReport({
      runId: "run-parity",
      datasetId: "golden",
      datasetVersion: 1,
      targetLabel: "a",
      k: 1,
      results: cliResults,
      createdAt: 0,
    })

    expect(cliReport.passAt1).toBe(app.report.passAt1)
    expect(cliReport.passHatK).toBe(app.report.passHatK)
    expect(cliReport.gradedCaseCount).toBe(app.report.gradedCaseCount)
    expect(cliReport.ungradedCaseCount).toBe(app.report.ungradedCaseCount)
    expect(cliReport.scorers).toEqual(app.report.scorers)
    expect(cliReport.scoringVersion).toBe(app.report.scoringVersion)

    // Guard against agreement on nothing: two paths that both grade zero cases
    // would satisfy every assertion above.
    expect(app.report.gradedCaseCount).toBeGreaterThan(0)
    expect(
      Object.values(app.report.scorers).filter((aggregate) => aggregate.scoredCount > 0).length
    ).toBeGreaterThan(1)
  })

  it("stays in step when a case FAILS, not just when everything passes", async () => {
    // The golden fixture is all-passing, so parity over it alone could not tell
    // a shared verdict from a shared "always pass". Break one trajectory and
    // require both paths to report the same failure.
    const [broken] = CASES
    const degrade = (evalCase: EvalCase): EvalSample =>
      evalCase.id === broken.id
        ? { ...replay(evalCase), output: "", toolCalls: [] }
        : replay(evalCase)
    mockRunTarget.mockImplementation((evalCase: EvalCase) => Promise.resolve(degrade(evalCase)))

    const app = await runDatasetEval({
      dataset: dataset(),
      cases: CASES,
      scorers: deterministicScorers(),
      target: { label: "a", run: async (evalCase) => degrade(evalCase) },
      runId: "run-parity-fail",
      now: 0,
    })

    const directory = await mkdtemp(path.join(tmpdir(), "cognia-parity-fail-"))
    const result = await executeCliEvalProject(
      { project: project(), cases: CASES },
      path.join(directory, "checkpoint.json")
    )
    const checkpoint = result.checkpoint as CliEvalCheckpoint

    expect(app.report.passAt1).toBeLessThan(1)
    for (const [index, evalCase] of CASES.entries()) {
      const cliRow = checkpoint.samples.find(
        (row) => row.caseId === evalCase.id && row.repetition === 1
      )
      expect(cliRow?.verdict).toBe(repetitionVerdict(app.results[index].repetitions[0]))
    }
    expect(
      checkpoint.samples.find((row) => row.caseId === broken.id && row.repetition === 1)?.verdict
    ).toBe("fail")
  })
})
