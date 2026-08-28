/** cognia-eval builtin plugin — tool registration + handlers. */
import evalPlugin, { runEvalDatasetTool, runCalibrationTool, runEvalProjectV2Tool } from "./index"
import type { PluginContext } from "@cognia/plugin-sdk"
const mockVerifiedPreflight = jest.fn(async (..._args: unknown[]): Promise<unknown> => undefined)
const mockProjectStart = jest.fn(async (..._args: unknown[]): Promise<unknown> => undefined)
const mockProjectPause = jest.fn(async (..._args: unknown[]) => {})
const mockProjectResume = jest.fn(async (..._args: unknown[]) => {})
const mockProjectCancel = jest.fn(async (..._args: unknown[]) => {})
const mockProjectStatus = jest.fn(async (..._args: unknown[]): Promise<unknown> => undefined)
const mockProjectReport = jest.fn(async (..._args: unknown[]): Promise<unknown> => undefined)
const mockProjectExtend = jest.fn(async (..._args: unknown[]) => {})
const mockProjectRun = jest.fn(async (..._args: unknown[]) => {})

// One double for the whole SDK subpath the plugin imports, rather than six for
// the host modules behind it: the plugin only ever sees this surface, so this
// is the surface the test should replace.
jest.mock("@cognia/plugin-sdk/api/eval", () => ({
  listDatasetSummaries: jest.fn(async () => [
    { id: "d1", name: "DS", capability: "chat", version: 1, caseCount: 2 },
  ]),
  getRunDetail: jest.fn(async (id: string) =>
    id === "r1" ? { report: { runId: "r1", passAt1: 1 }, cases: [] } : undefined
  ),
  runEvalService: jest.fn(async () => ({
    reports: [{ runId: "r1", passAt1: 1, passHatK: 1, totalCostUsd: 0, targetLabel: "m" }],
    gatePassed: true,
    deterministicOnly: true,
  })),
  runCalibration: jest.fn(async (input: { setId: string; judgeModel?: string }) => ({
    runId: "calrun_1",
    setId: input.setId,
    criterion: "task completion",
    rubric: "r",
    judgeModel: input.judgeModel ?? "(resolver default)",
    itemCount: 3,
    scoredCount: 3,
    erroredCount: 0,
    metrics: { matrix: { tp: 2, fp: 0, tn: 1, fn: 0 }, n: 3, cohenKappa: 1 },
    verdicts: [],
    createdAt: 1,
  })),
  loadEvalAppSettings: async () => ({ defaultProvider: "local" }),
  loadEvalRuntimeContext: async () => ({
    settings: { defaultProvider: "local" },
    accountId: "account",
  }),
  EvalProjectService: class {
    verifiedPreflight(...args: unknown[]) {
      return mockVerifiedPreflight(...args)
    }
    start(...args: unknown[]) {
      return mockProjectStart(...args)
    }
    pause(...args: unknown[]) {
      return mockProjectPause(...args)
    }
    resume(...args: unknown[]) {
      return mockProjectResume(...args)
    }
    cancel(...args: unknown[]) {
      return mockProjectCancel(...args)
    }
    status(...args: unknown[]) {
      return mockProjectStatus(...args)
    }
    report(...args: unknown[]) {
      return mockProjectReport(...args)
    }
    extendBudget(...args: unknown[]) {
      return mockProjectExtend(...args)
    }
  },
  createBrowserEvalOrchestrator: () => ({ run: (...args: unknown[]) => mockProjectRun(...args) }),
  loadOrCreateEvalArtifactKey: async () => new Uint8Array(32),
  SCORING_VERSION: 1,
  deterministicScorers: () => [],
}))

import { runCalibration, runEvalService } from "@cognia/plugin-sdk/api/eval"
interface RegisteredTool {
  name: string
  execute: (args: Record<string, unknown>) => Promise<unknown>
}

async function activate(): Promise<Map<string, RegisteredTool>> {
  const tools = new Map<string, RegisteredTool>()
  const ctx = {
    pluginId: "cognia-eval",
    logger: { info: jest.fn() },
    agent: {
      registerTool: (tool: RegisteredTool) => {
        tools.set(tool.name, tool)
      },
    },
  } as unknown as PluginContext
  await evalPlugin.activate!(ctx)
  return tools
}

beforeEach(() => {
  ;(runEvalService as jest.Mock).mockClear()
  mockVerifiedPreflight.mockReset()
  mockProjectStart.mockReset()
  mockProjectStatus.mockReset()
  mockProjectReport.mockReset()
  mockVerifiedPreflight.mockResolvedValue({
    environmentCompatibility: {
      checkedAt: 1,
      runtimeByVariant: {},
      storage: { status: "available", requiredBytes: 1, availableBytes: 2 },
    },
    result: { ok: true, issues: [], compatibleVariantIds: [], effectiveCaseIds: [] },
  })
  mockProjectStart.mockResolvedValue({ id: "experiment", state: "queued" })
  mockProjectStatus.mockResolvedValue({ experiment: { state: "running" }, tasks: {} })
  mockProjectReport.mockResolvedValue({ experiment: { state: "completed" }, samples: [] })
})

describe("cognia-eval plugin", () => {
  it("registers legacy tools and the versioned project API", async () => {
    const tools = await activate()
    expect([...tools.keys()].sort()).toEqual([
      "eval_get_run",
      "eval_list_datasets",
      "eval_project_v2",
      "eval_run_calibration",
      "eval_run_dataset",
    ])
  })

  it("validates identifiers at the versioned project API boundary", async () => {
    await expect(runEvalProjectV2Tool({ action: "preflight" })).rejects.toThrow(/projectId/)
    await expect(runEvalProjectV2Tool({ action: "status" })).rejects.toThrow(/experimentId/)
    await expect(
      runEvalProjectV2Tool({ action: "extend-budget", experimentId: "experiment" })
    ).rejects.toThrow(/budgetCap/)
  })

  it("executes the complete versioned project lifecycle API", async () => {
    await expect(
      runEvalProjectV2Tool({ action: "preflight", projectId: "project" })
    ).resolves.toMatchObject({
      result: { ok: true },
    })
    await expect(runEvalProjectV2Tool({ action: "start", projectId: "project" })).resolves.toEqual({
      experimentId: "experiment",
      state: "queued",
    })
    expect(mockProjectRun).toHaveBeenCalledWith("experiment")

    await runEvalProjectV2Tool({ action: "pause", experimentId: "experiment" })
    await runEvalProjectV2Tool({ action: "cancel", experimentId: "experiment" })
    await runEvalProjectV2Tool({
      action: "extend-budget",
      experimentId: "experiment",
      budgetCap: 25,
    })
    await runEvalProjectV2Tool({ action: "resume", experimentId: "experiment" })
    await expect(
      runEvalProjectV2Tool({ action: "status", experimentId: "experiment" })
    ).resolves.toMatchObject({ experiment: { state: "running" } })
    await expect(
      runEvalProjectV2Tool({ action: "report", experimentId: "experiment" })
    ).resolves.toMatchObject({ experiment: { state: "completed" } })

    expect(mockProjectPause).toHaveBeenCalledWith("experiment")
    expect(mockProjectCancel).toHaveBeenCalledWith("experiment")
    expect(mockProjectExtend).toHaveBeenCalledWith("experiment", 25)
    expect(mockProjectResume).toHaveBeenCalledWith("experiment")
  })

  it("returns blocking preflight evidence without starting or spending", async () => {
    mockVerifiedPreflight.mockResolvedValueOnce({
      environmentCompatibility: {
        checkedAt: 1,
        runtimeByVariant: {},
        storage: { status: "insufficient", requiredBytes: 2, availableBytes: 1 },
      },
      result: {
        ok: false,
        issues: [{ code: "DISK_QUOTA_INSUFFICIENT" }],
        compatibleVariantIds: [],
        effectiveCaseIds: [],
      },
    })

    await expect(
      runEvalProjectV2Tool({ action: "start", projectId: "project" })
    ).resolves.toMatchObject({
      result: { ok: false },
    })
    expect(mockProjectStart).not.toHaveBeenCalled()
    expect(mockProjectRun).not.toHaveBeenCalled()
  })

  it("eval_list_datasets returns summaries", async () => {
    const tools = await activate()
    await expect(tools.get("eval_list_datasets")!.execute({})).resolves.toEqual([
      expect.objectContaining({ id: "d1", caseCount: 2 }),
    ])
  })

  it("eval_run_dataset runs a chat target and returns the report summary", async () => {
    const tools = await activate()
    const res = await tools.get("eval_run_dataset")!.execute({ datasetId: "d1", model: "m", k: 1 })
    expect(runEvalService).toHaveBeenCalledWith(
      expect.objectContaining({
        datasetId: "d1",
        config: expect.objectContaining({
          targets: [expect.objectContaining({ kind: "chat", model: "m" })],
        }),
      })
    )
    expect(res).toEqual(
      expect.objectContaining({
        runIds: ["r1"],
        passAt1: 1,
        gatePassed: true,
        deterministicOnly: true,
      })
    )
  })

  it("eval_run_dataset builds team/workflow targets and validates refs", async () => {
    await runEvalDatasetTool({ datasetId: "d1", targetKind: "team", teamId: "tm1" })
    expect(runEvalService).toHaveBeenLastCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          targets: [expect.objectContaining({ kind: "team", teamId: "tm1" })],
        }),
      })
    )
    await expect(runEvalDatasetTool({ datasetId: "d1", targetKind: "team" })).rejects.toThrow(
      /teamId/
    )
    await expect(runEvalDatasetTool({ datasetId: "d1", targetKind: "workflow" })).rejects.toThrow(
      /workflowId/
    )
    await expect(runEvalDatasetTool({ datasetId: "d1" })).rejects.toThrow(/model/)
    await expect(runEvalDatasetTool({ datasetId: "" } as never)).rejects.toThrow(/datasetId/)
  })

  it("eval_run_dataset passes workflow targets, character, subset and gates through", async () => {
    ;(runEvalService as jest.Mock).mockResolvedValueOnce({
      reports: [{ runId: "r9", passAt1: 0.5, passHatK: 0.5, totalCostUsd: 1, targetLabel: "wf1" }],
      gates: { r9: { passed: false, failures: ["x"] } },
      gatePassed: false,
      deterministicOnly: false,
    })
    const res = await runEvalDatasetTool({
      datasetId: "d1",
      targetKind: "workflow",
      workflowId: "wf1",
      split: "test",
      capabilities: ["a"],
      scorerIds: ["assertion"],
      k: 2,
    })
    expect(runEvalService).toHaveBeenLastCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          targets: [expect.objectContaining({ kind: "workflow", workflowId: "wf1" })],
          subset: { split: "test", capabilities: ["a"] },
          scorerIds: ["assertion"],
          k: 2,
        }),
      })
    )
    expect(res).toEqual(
      expect.objectContaining({
        gatePassed: false,
        gates: { r9: { passed: false, failures: ["x"] } },
      })
    )
  })

  it("eval_run_dataset includes characterId on chat targets", async () => {
    await runEvalDatasetTool({ datasetId: "d1", model: "m", characterId: "ch1" })
    expect(runEvalService).toHaveBeenLastCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          targets: [expect.objectContaining({ kind: "chat", characterId: "ch1" })],
        }),
      })
    )
  })

  it("eval_run_dataset throws when the service produces no report", async () => {
    ;(runEvalService as jest.Mock).mockResolvedValueOnce({ reports: [], deterministicOnly: true })
    await expect(runEvalDatasetTool({ datasetId: "d1", model: "m" })).rejects.toThrow(/no report/)
  })

  it("eval_get_run returns the detail and rejects unknown runs", async () => {
    const tools = await activate()
    await expect(tools.get("eval_get_run")!.execute({ runId: "r1" })).resolves.toEqual(
      expect.objectContaining({ report: expect.objectContaining({ runId: "r1" }) })
    )
    await expect(tools.get("eval_get_run")!.execute({ runId: "ghost" })).rejects.toThrow(
      /not found/
    )
    await expect(tools.get("eval_get_run")!.execute({})).rejects.toThrow(/not found/)
  })

  it("eval_run_calibration calibrates a judge and returns the agreement metrics", async () => {
    const tools = await activate()
    const res = await tools
      .get("eval_run_calibration")!
      .execute({ setId: "set-a", judgeModel: "claude-sonnet-4-6" })
    expect(runCalibration).toHaveBeenCalledWith(
      expect.objectContaining({ setId: "set-a", judgeModel: "claude-sonnet-4-6" })
    )
    expect(res).toEqual(
      expect.objectContaining({
        runId: "calrun_1",
        criterion: "task completion",
        scoredCount: 3,
        metrics: expect.objectContaining({ cohenKappa: 1 }),
      })
    )
  })

  it("eval_run_calibration requires a setId", async () => {
    await expect(runCalibrationTool({ setId: "" })).rejects.toThrow(/setId/)
  })

  it("eval_run_calibration omits judgeModel when not provided", async () => {
    const res = await runCalibrationTool({ setId: "set-a" })
    expect(runCalibration).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ judgeModel: expect.anything() })
    )
    expect(res.judgeModel).toBe("(resolver default)")
  })

  it("omits gate fields when the dataset has no thresholds and deactivates cleanly", async () => {
    const res = await runEvalDatasetTool({ datasetId: "d1", model: "m" })
    expect(res).not.toHaveProperty("gates")
    await expect(evalPlugin.deactivate!(undefined as never)).resolves.toBeUndefined()
  })
})
