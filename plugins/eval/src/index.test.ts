import type { PluginContext } from "@cognia/plugin-sdk"
import evalPlugin, { runCalibrationTool, runEvalDatasetTool, runEvalProjectV2Tool } from "./index"

interface RegisteredTool {
  name: string
  execute: (args: Record<string, unknown>) => Promise<unknown>
}

const evalApi = {
  listDatasets: jest.fn(async () => [{ id: "dataset" }]),
  getRun: jest.fn(async (runId: string) => (runId === "run" ? { runId } : undefined)),
  runDataset: jest.fn(async () => ({ runIds: ["run"] })),
  runCalibration: jest.fn(async () => ({ runId: "calibration" })),
  runProject: jest.fn(async () => ({ experimentId: "experiment" })),
}

async function activate(): Promise<Map<string, RegisteredTool>> {
  const tools = new Map<string, RegisteredTool>()
  await evalPlugin.activate?.({
    pluginId: "cognia-eval",
    logger: { info: jest.fn() },
    eval: evalApi,
    agent: {
      registerTool: (tool: RegisteredTool) => {
        tools.set(tool.name, tool)
      },
    },
  } as unknown as PluginContext)
  return tools
}

beforeEach(() => jest.clearAllMocks())

describe("cognia-eval plugin", () => {
  it("registers every eval tool", async () => {
    const tools = await activate()
    expect([...tools.keys()].sort()).toEqual([
      "eval_get_run",
      "eval_list_datasets",
      "eval_project_v2",
      "eval_run_calibration",
      "eval_run_dataset",
    ])
  })

  it("delegates tools to the governed eval context", async () => {
    const tools = await activate()
    await expect(tools.get("eval_list_datasets")!.execute({})).resolves.toEqual([{ id: "dataset" }])
    await tools.get("eval_run_dataset")!.execute({ datasetId: "dataset", model: "model" })
    await tools.get("eval_run_calibration")!.execute({ setId: "set" })
    await tools.get("eval_project_v2")!.execute({ action: "status", experimentId: "experiment" })
    await expect(tools.get("eval_get_run")!.execute({ runId: "run" })).resolves.toEqual({
      runId: "run",
    })

    expect(evalApi.runDataset).toHaveBeenCalledWith({ datasetId: "dataset", model: "model" })
    expect(evalApi.runCalibration).toHaveBeenCalledWith({ setId: "set" })
    expect(evalApi.runProject).toHaveBeenCalledWith({
      action: "status",
      experimentId: "experiment",
    })
  })

  it("preserves the missing-run error at the tool boundary", async () => {
    const tools = await activate()
    await expect(tools.get("eval_get_run")!.execute({ runId: "missing" })).rejects.toThrow(
      /not found/
    )
  })

  it("exports helpers backed by the activated context", async () => {
    await activate()
    await runEvalDatasetTool({ datasetId: "dataset", model: "model" })
    await runCalibrationTool({ setId: "set" })
    await runEvalProjectV2Tool({ action: "status", experimentId: "experiment" })
    expect(evalApi.runDataset).toHaveBeenCalled()
    expect(evalApi.runCalibration).toHaveBeenCalled()
    expect(evalApi.runProject).toHaveBeenCalled()
  })

  it("clears its captured context on deactivate", async () => {
    await activate()
    await evalPlugin.deactivate?.({} as PluginContext)
    expect(() => runEvalDatasetTool({ datasetId: "dataset", model: "model" })).toThrow(
      /unavailable/
    )
  })
})
