const mockVerifiedPreflight = jest.fn()
const mockStart = jest.fn()
const mockStatus = jest.fn()
const mockRun = jest.fn()

jest.mock("@/lib/ai/eval/service", () => ({
  listDatasetSummaries: jest.fn(async () => [{ id: "dataset" }]),
  getRunDetail: jest.fn(async (id: string) => (id === "run" ? { runId: id } : undefined)),
  runEvalService: jest.fn(async () => ({
    reports: [{ runId: "run", targetLabel: "model", passAt1: 1, passHatK: 1, totalCostUsd: 0 }],
    gatePassed: true,
    deterministicOnly: true,
  })),
}))
jest.mock("@/lib/ai/eval/calibration/runner", () => ({
  runCalibration: jest.fn(async () => ({
    runId: "calibration",
    criterion: "quality",
    judgeModel: "judge",
    itemCount: 2,
    scoredCount: 2,
    erroredCount: 0,
    metrics: { accuracy: 1 },
  })),
}))
jest.mock("@/lib/ai/eval/runtime-context", () => ({
  loadEvalAppSettings: jest.fn(async () => ({ defaultProvider: "local" })),
  loadEvalRuntimeContext: jest.fn(async () => ({
    settings: { defaultProvider: "local" },
    localAccountId: "account",
  })),
}))
jest.mock("@/lib/ai/eval/project-service", () => ({
  EvalProjectService: class {
    verifiedPreflight = mockVerifiedPreflight
    start = mockStart
    pause = jest.fn()
    resume = jest.fn()
    cancel = jest.fn()
    status = mockStatus
    report = jest.fn()
    extendBudget = jest.fn()
  },
}))
jest.mock("@/lib/ai/eval/browser-execution", () => ({
  createBrowserEvalOrchestrator: () => ({ run: mockRun }),
}))
jest.mock("@/lib/ai/eval/artifact-crypto", () => ({
  loadOrCreateEvalArtifactKey: jest.fn(async () => new Uint8Array(32)),
}))
jest.mock("@cognia/eval-core", () => ({
  ...jest.requireActual("@cognia/eval-core"),
  deterministicScorers: () => [],
  SCORING_VERSION: 1,
}))
jest.mock("@/lib/app-version", () => ({ APP_VERSION: "test" }))

import { runEvalService } from "@/lib/ai/eval/service"
import { createEvalAPI } from "./eval-api"

describe("createEvalAPI", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockVerifiedPreflight.mockResolvedValue({
      result: { ok: true },
      environmentCompatibility: { checkedAt: 1 },
    })
    mockStart.mockResolvedValue({ id: "experiment", state: "queued" })
    mockStatus.mockResolvedValue({ experiment: { state: "running" } })
  })

  it("runs a dataset through the canonical service", async () => {
    await expect(
      createEvalAPI().runDataset({ datasetId: "dataset", model: "model" })
    ).resolves.toEqual(expect.objectContaining({ runIds: ["run"], passAt1: 1, gatePassed: true }))
    expect(runEvalService).toHaveBeenCalledWith(
      expect.objectContaining({
        datasetId: "dataset",
        config: expect.objectContaining({
          targets: [expect.objectContaining({ kind: "chat", model: "model" })],
        }),
      })
    )
  })

  it("validates target-specific identifiers", async () => {
    const api = createEvalAPI()
    await expect(api.runDataset({ datasetId: "dataset", targetKind: "team" })).rejects.toThrow(
      /teamId/
    )
    await expect(api.runDataset({ datasetId: "dataset" })).rejects.toThrow(/model/)
    await expect(api.runCalibration({ setId: "" })).rejects.toThrow(/setId/)
  })

  it("starts and reports a durable project", async () => {
    const api = createEvalAPI()
    await expect(api.runProject({ action: "start", projectId: "project" })).resolves.toEqual({
      experimentId: "experiment",
      state: "queued",
    })
    expect(mockRun).toHaveBeenCalledWith("experiment")
    await expect(api.runProject({ action: "status", experimentId: "experiment" })).resolves.toEqual(
      { experiment: { state: "running" } }
    )
  })
})
