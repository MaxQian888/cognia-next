/** @jest-environment node */

import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { EvalProject } from "@cognia/eval-core"
import { deterministicScorers } from "@/lib/ai/eval/scorers"
import { executeCliEvalProject, type CliEvalCheckpoint } from "./execute-project"

const mockRunTarget = jest.fn()
jest.mock("@/lib/ai/eval/targets/model", () => ({
  createPureModelEvalTarget: () => ({ run: (...args: unknown[]) => mockRunTarget(...args) }),
}))

function project(): EvalProject {
  return {
    id: "project-1",
    name: "Resumable evaluation",
    mode: "model",
    dataset: {
      datasetId: "dataset-1",
      version: 1,
      digest: "sha256:data",
      caseIds: ["case-1"],
      holdoutCaseIds: [],
      requiredModalities: ["text"],
    },
    variants: ["a", "b"].map((id) => ({
      id,
      name: id,
      kind: "model" as const,
      providerId: "local",
      modelId: `model-${id}`,
      runtimeTarget: "web" as const,
      isLocal: true,
      capabilities: ["text" as const],
      available: true,
      credentialReady: true,
      runtimeReady: true,
    })),
    decisionPolicy: {
      formal: false,
      dimensions: [{ metric: "quality", direction: "maximize", weight: 1 }],
      constraints: [],
      confidenceLevel: 0.95,
      minimumEffectiveCases: 1,
    },
    budget: { currency: "USD", hardCap: 1, confirmed: true },
    judgePolicy: {
      enabled: false,
      calibrated: false,
      anchorCount: 0,
      kappa: 0,
      accuracy: 0,
    },
    privacyPolicy: { cloudPiiMode: "redact", mediaClearance: "local-only" },
    retentionDays: 90,
    createdAt: 1,
    updatedAt: 1,
  }
}

/** A complete `EvalSample`, so scorers see every field they read. */
function sample(overrides: Record<string, unknown> = {}) {
  return {
    output: "answer",
    toolCalls: [],
    retrievedChunks: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    costUsd: 0,
    latencyMs: 20,
    stepCount: 1,
    degraded: false,
    ...overrides,
  }
}

/**
 * One variant only. With two variants the OLD code accidentally answered
 * `no_conclusion` via `confidence_overlap` (both sat at a degenerate [1,1]
 * interval), which hid the real defect. A single variant has no runner-up, so
 * the overlap check never fires and the fabricated recommendation is visible.
 */
function soloProject(): EvalProject {
  const input = project()
  input.variants = input.variants.slice(0, 1)
  return input
}

describe("executeCliEvalProject grading", () => {
  beforeEach(() => {
    mockRunTarget.mockReset()
    mockRunTarget.mockResolvedValue(sample())
  })

  it("refuses to recommend on a dataset carrying no reference answers", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cognia-eval-"))
    const checkpointPath = path.join(directory, "checkpoint.json")

    const result = await executeCliEvalProject(
      { project: soloProject(), cases: [{ id: "case-1", datasetId: "d", input: "question" }] },
      checkpointPath
    )
    const checkpoint = result.checkpoint as CliEvalCheckpoint

    // Before the shared scorers landed this returned exit 0 with a recommended
    // variant, off a quality vector of 1.0s produced by "non-empty output".
    expect(result.exitCode).toBe(2)
    expect(checkpoint.outcome).toBe("no_conclusion")
    expect(checkpoint.recommendation?.reason).toBe("insufficient_cases")
    expect(checkpoint.recommendation?.recommendedVariantId).toBeUndefined()
    expect(checkpoint.samples.every((row) => row.verdict === "ungraded")).toBe(true)
  })

  it("grades a case whose reference states how it is compared", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cognia-eval-"))
    const checkpointPath = path.join(directory, "checkpoint.json")

    const result = await executeCliEvalProject(
      {
        project: soloProject(),
        cases: [
          {
            id: "case-1",
            datasetId: "d",
            input: "question",
            reference: { expectedOutput: "answer", grading: { mode: "exact" } },
          },
        ],
      },
      checkpointPath
    )
    const checkpoint = result.checkpoint as CliEvalCheckpoint

    expect(checkpoint.samples[0].verdict).toBe("pass")
    expect(checkpoint.samples[0].quality).toBe(1)
    expect(result.exitCode).toBe(0)
    expect(checkpoint.recommendation?.recommendedVariantId).toBe("a")
  })

  it("counts a wrong answer as a graded failure, not as ungraded", async () => {
    mockRunTarget.mockResolvedValue(sample({ output: "something else" }))
    const directory = await mkdtemp(path.join(tmpdir(), "cognia-eval-"))
    const checkpointPath = path.join(directory, "checkpoint.json")

    const result = await executeCliEvalProject(
      {
        project: soloProject(),
        cases: [
          {
            id: "case-1",
            datasetId: "d",
            input: "question",
            reference: { expectedOutput: "answer", grading: { mode: "exact" } },
          },
        ],
      },
      checkpointPath
    )
    const checkpoint = result.checkpoint as CliEvalCheckpoint

    expect(checkpoint.samples[0].verdict).toBe("fail")
    expect(checkpoint.samples[0].quality).toBe(0)
  })

  it("records a provider failure as a graded failure so a crashing variant loses", async () => {
    mockRunTarget.mockRejectedValue(new Error("provider unavailable"))
    const directory = await mkdtemp(path.join(tmpdir(), "cognia-eval-"))
    const checkpointPath = path.join(directory, "checkpoint.json")

    const result = await executeCliEvalProject(
      { project: soloProject(), cases: [{ id: "case-1", datasetId: "d", input: "question" }] },
      checkpointPath
    )
    const checkpoint = result.checkpoint as CliEvalCheckpoint

    expect(checkpoint.samples[0]).toMatchObject({ status: "failed", verdict: "fail" })
  })

  it("keeps every shared scorer's observation as run evidence", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cognia-eval-"))
    const checkpointPath = path.join(directory, "checkpoint.json")

    const result = await executeCliEvalProject(
      { project: soloProject(), cases: [{ id: "case-1", datasetId: "d", input: "question" }] },
      checkpointPath
    )
    const checkpoint = result.checkpoint as CliEvalCheckpoint

    const recorded = (checkpoint.samples[0].scores ?? []).map((score) => score.scorerId)
    expect(recorded).toEqual(deterministicScorers().map((scorer) => scorer.id))
  })
})

describe("executeCliEvalProject checkpoints", () => {
  beforeEach(() => {
    mockRunTarget.mockReset()
    mockRunTarget.mockResolvedValue(sample())
  })

  it("returns an already-completed checkpoint without spending again", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cognia-eval-"))
    const checkpointPath = path.join(directory, "checkpoint.json")
    const checkpoint: CliEvalCheckpoint = {
      schema: "cognia-eval-checkpoint/v1",
      projectId: "project-1",
      status: "completed",
      outcome: "recommended",
      spentCost: 0.42,
      hardCap: 1,
      completedTasks: 1,
      totalTasks: 1,
      samples: [],
      updatedAt: new Date(0).toISOString(),
    }
    await writeFile(checkpointPath, JSON.stringify(checkpoint), "utf8")

    const result = await executeCliEvalProject(
      { project: project(), cases: [{ id: "case-1", input: "hello" }] },
      checkpointPath
    )

    expect(result).toEqual({ exitCode: 0, checkpoint })
  })

  it("rejects a checkpoint owned by another project", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cognia-eval-"))
    const checkpointPath = path.join(directory, "checkpoint.json")
    await writeFile(
      checkpointPath,
      JSON.stringify({ schema: "cognia-eval-checkpoint/v1", projectId: "other" }),
      "utf8"
    )

    await expect(
      executeCliEvalProject(
        { project: project(), cases: [{ id: "case-1", input: "hello" }] },
        checkpointPath
      )
    ).rejects.toThrow("different project")
  })

  it("marks an ambiguous in-flight checkpoint interrupted without replaying provider spend", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cognia-eval-"))
    const checkpointPath = path.join(directory, "checkpoint.json")
    const checkpoint: CliEvalCheckpoint = {
      schema: "cognia-eval-checkpoint/v1",
      projectId: "project-1",
      status: "running",
      spentCost: 0,
      hardCap: 1,
      completedTasks: 0,
      totalTasks: 2,
      samples: [
        {
          variantId: "a",
          caseId: "case-1",
          repetition: 1,
          status: "running",
          quality: 0,
          cost: 0,
          latencyMs: 0,
        },
      ],
      updatedAt: new Date(0).toISOString(),
    }
    await writeFile(checkpointPath, JSON.stringify(checkpoint), "utf8")

    const result = await executeCliEvalProject(
      { project: project(), cases: [{ id: "case-1", input: "hello" }] },
      checkpointPath
    )

    expect(result).toMatchObject({
      exitCode: 1,
      checkpoint: {
        status: "interrupted",
        samples: [expect.objectContaining({ status: "interrupted" })],
      },
    })
    expect(mockRunTarget).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(checkpointPath, "utf8"))).toMatchObject({
      status: "interrupted",
    })
  })

  it("executes, checkpoints, adaptively repeats, and reports a recommendation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cognia-eval-"))
    const checkpointPath = path.join(directory, "checkpoint.json")
    const input = project()

    const result = await executeCliEvalProject(
      {
        project: input,
        cases: [
          {
            id: "case-1",
            datasetId: "dataset-1",
            input: "question",
            reference: { expectedOutput: "answer" },
          },
        ],
      },
      checkpointPath
    )

    expect(result.exitCode).toBe(2)
    expect(result.checkpoint).toMatchObject({
      schema: "cognia-eval-checkpoint/v1",
      projectId: input.id,
      status: "completed",
      outcome: "no_conclusion",
      spentCost: 0,
    })
    expect((result.checkpoint as CliEvalCheckpoint).samples.length).toBeGreaterThanOrEqual(2)
    expect(JSON.parse(await readFile(checkpointPath, "utf8"))).toMatchObject({
      projectId: input.id,
    })
  })

  it("pauses before dispatch when the next worst-case reservation exceeds the cap", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cognia-eval-"))
    const checkpointPath = path.join(directory, "checkpoint.json")
    const input = project()
    input.budget.hardCap = 0.000001
    input.variants = input.variants.map((variant) => ({
      ...variant,
      isLocal: false,
      price: { currency: "USD", inputPerMillion: 100, outputPerMillion: 100 },
      parameters: { maxOutputTokens: 4_096 },
    }))

    const result = await executeCliEvalProject(
      { project: input, cases: [{ id: "case-1", input: "question" }] },
      checkpointPath
    )

    expect(result).toMatchObject({ exitCode: 2, checkpoint: { status: "paused" } })
    expect(mockRunTarget).not.toHaveBeenCalled()
  })

  it("records provider failures as case evidence instead of losing the checkpoint", async () => {
    mockRunTarget.mockRejectedValue(new Error("provider unavailable"))
    const directory = await mkdtemp(path.join(tmpdir(), "cognia-eval-"))
    const checkpointPath = path.join(directory, "checkpoint.json")

    const result = await executeCliEvalProject(
      { project: project(), cases: [{ id: "case-1", input: "question" }] },
      checkpointPath
    )

    expect((result.checkpoint as CliEvalCheckpoint).samples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "failed", error: "provider unavailable" }),
      ])
    )
  })

  it("rejects Agent projects and empty embedded case sets at the CLI boundary", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cognia-eval-"))
    const checkpointPath = path.join(directory, "checkpoint.json")
    const agent = project()
    agent.mode = "agent"

    await expect(
      executeCliEvalProject({ project: agent, cases: [{}] }, checkpointPath)
    ).rejects.toThrow("Agent projects")
    await expect(
      executeCliEvalProject({ project: project(), cases: [] }, checkpointPath)
    ).rejects.toThrow("non-empty cases")
  })

  it("rejects unsupported checkpoint schemas", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cognia-eval-"))
    const checkpointPath = path.join(directory, "checkpoint.json")
    await writeFile(
      checkpointPath,
      JSON.stringify({ schema: "legacy", projectId: "project-1" }),
      "utf8"
    )

    await expect(
      executeCliEvalProject(
        { project: project(), cases: [{ id: "case-1", input: "hello" }] },
        checkpointPath
      )
    ).rejects.toThrow("Unsupported")
  })
})
