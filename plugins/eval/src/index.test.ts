import type { PluginContext, PluginToolContext, PluginToolRegistration } from "@cognia/plugin-sdk"

import manifestJson from "../plugin.json"
import evalPlugin, {
  EVAL_MAX_K,
  EVAL_PROJECT_TIMEOUT_MS,
  EVAL_RUN_TIMEOUT_MS,
  EVAL_TOOL_NAMES,
  manifest,
  parseProjectArgs,
  parseRunDatasetArgs,
} from "./index"

const evalApi = {
  listDatasets: jest.fn(async () => [{ id: "dataset" }]),
  getRun: jest.fn(async (runId: string) => (runId === "run" ? { runId } : undefined)),
  runDataset: jest.fn(async () => ({ runIds: ["run"] })),
  runCalibration: jest.fn(async () => ({ runId: "calibration" })),
  runProject: jest.fn(async () => ({ experimentId: "experiment" })),
}

async function activate() {
  const tools = new Map<string, PluginToolRegistration>()
  await evalPlugin.activate({
    pluginId: "cognia-eval",
    logger: { info: jest.fn() },
    eval: evalApi,
    agent: {
      registerTool: (tool: PluginToolRegistration) => {
        tools.set(tool.name, tool)
        return () => undefined
      },
    },
  } as unknown as PluginContext)
  const call = (
    name: string,
    args: Record<string, unknown>,
    callCtx: Partial<PluginToolContext> = {}
  ) => tools.get(name)!.execute(args, { config: {}, ...callCtx })
  return { tools, call }
}

beforeEach(() => jest.clearAllMocks())

describe("cognia-eval manifest", () => {
  it("adopts plugin.json itself as the manifest", () => {
    expect(manifest).toEqual(manifestJson)
    expect(evalPlugin.manifest).toBe(manifest)
  })
})

describe("cognia-eval tools", () => {
  it("registers every eval tool without a caller-supplied pluginId", async () => {
    const { tools } = await activate()
    expect([...tools.keys()].sort()).toEqual([...EVAL_TOOL_NAMES].sort())
    for (const tool of tools.values()) expect(tool.pluginId).toBeUndefined()
  })

  it("gates every token-spending tool on approval and gives it a long budget", async () => {
    const { tools } = await activate()
    for (const name of ["eval_run_dataset", "eval_run_calibration"]) {
      expect(tools.get(name)!.definition).toMatchObject({
        requiresApproval: true,
        timeoutMs: EVAL_RUN_TIMEOUT_MS,
      })
    }
    expect(EVAL_RUN_TIMEOUT_MS).toBe(600_000)
    expect(tools.get("eval_project_v2")!.definition).toMatchObject({
      requiresApproval: true,
      timeoutMs: EVAL_PROJECT_TIMEOUT_MS,
    })
    for (const name of ["eval_list_datasets", "eval_get_run"]) {
      expect(tools.get(name)!.definition.requiresApproval).toBeUndefined()
    }
  })

  it("bounds k as an integer and documents every eval_project_v2 parameter", async () => {
    const { tools } = await activate()
    const runProps = tools.get("eval_run_dataset")!.definition.parametersSchema
      .properties as Record<string, Record<string, unknown>>
    expect(runProps.k).toMatchObject({ type: "integer", minimum: 1, maximum: EVAL_MAX_K })
    const projectProps = tools.get("eval_project_v2")!.definition.parametersSchema
      .properties as Record<string, { description?: string }>
    for (const key of ["action", "projectId", "experimentId", "budgetCap"]) {
      expect(projectProps[key].description).toEqual(expect.any(String))
    }
  })

  it("delegates validated arguments to ctx.eval", async () => {
    const { call } = await activate()
    await expect(call("eval_list_datasets", {})).resolves.toEqual([{ id: "dataset" }])
    await call("eval_run_dataset", { datasetId: "dataset", model: "model", k: 2 })
    await call("eval_run_calibration", { setId: "set", judgeModel: "judge" })
    await call("eval_project_v2", { action: "status", experimentId: "experiment" })
    await expect(call("eval_get_run", { runId: "run" })).resolves.toEqual({ runId: "run" })

    expect(evalApi.runDataset).toHaveBeenCalledWith({
      datasetId: "dataset",
      targetKind: "chat",
      model: "model",
      k: 2,
    })
    expect(evalApi.runCalibration).toHaveBeenCalledWith({ setId: "set", judgeModel: "judge" })
    expect(evalApi.runProject).toHaveBeenCalledWith({
      action: "status",
      experimentId: "experiment",
    })
  })

  it("answers a missing run with {ok:false} instead of throwing", async () => {
    const { call } = await activate()
    await expect(call("eval_get_run", { runId: "missing" })).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/no run "missing"/),
    })
    await expect(call("eval_get_run", {})).resolves.toEqual({
      ok: false,
      error: "eval_get_run: runId is required",
    })
  })

  it("collapses a host failure into the same envelope", async () => {
    evalApi.runDataset.mockRejectedValueOnce(
      new Error("eval_run_dataset: model is required for a chat target")
    )
    const { call } = await activate()
    await expect(call("eval_run_dataset", { datasetId: "dataset" })).resolves.toEqual({
      ok: false,
      error: "eval_run_dataset: model is required for a chat target",
    })
    evalApi.listDatasets.mockRejectedValueOnce(new Error("database locked"))
    await expect(call("eval_list_datasets", {})).resolves.toEqual({
      ok: false,
      error: "eval_list_datasets: database locked",
    })
  })

  it("does not start a run for a call that was already cancelled", async () => {
    const { call } = await activate()
    const controller = new AbortController()
    controller.abort()
    await expect(
      call("eval_run_dataset", { datasetId: "dataset", model: "m" }, { signal: controller.signal })
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/cancelled/) })
    expect(evalApi.runDataset).not.toHaveBeenCalled()
  })

  it("refuses malformed arguments before spending anything", async () => {
    const { call } = await activate()
    await expect(call("eval_run_dataset", { datasetId: "d", k: 2.5 })).resolves.toMatchObject({
      ok: false,
    })
    await expect(call("eval_run_calibration", {})).resolves.toMatchObject({ ok: false })
    await expect(call("eval_project_v2", { action: "explode" })).resolves.toMatchObject({
      ok: false,
    })
    expect(evalApi.runDataset).not.toHaveBeenCalled()
    expect(evalApi.runCalibration).not.toHaveBeenCalled()
    expect(evalApi.runProject).not.toHaveBeenCalled()
  })
})

describe("argument parsing", () => {
  it("parseRunDatasetArgs enforces integer k within bounds and a known target", () => {
    expect(parseRunDatasetArgs({ datasetId: "d", k: EVAL_MAX_K })).toMatchObject({ k: EVAL_MAX_K })
    for (const k of [0, EVAL_MAX_K + 1, 1.5, "2"]) {
      expect(parseRunDatasetArgs({ datasetId: "d", k })).toMatchObject({ ok: false })
    }
    expect(parseRunDatasetArgs({ datasetId: "d", targetKind: "robot" })).toMatchObject({
      ok: false,
    })
    expect(parseRunDatasetArgs({})).toMatchObject({ ok: false })
    expect(parseRunDatasetArgs({ datasetId: "d", scorerIds: [1] })).toMatchObject({ ok: false })
    expect(
      parseRunDatasetArgs({
        datasetId: " d ",
        targetKind: "team",
        teamId: "t",
        scorerIds: ["s"],
        split: "dev",
        capabilities: ["tools"],
      })
    ).toEqual({
      datasetId: "d",
      targetKind: "team",
      teamId: "t",
      scorerIds: ["s"],
      split: "dev",
      capabilities: ["tools"],
    })
  })

  it("parseProjectArgs asks for the id each action needs", () => {
    expect(parseProjectArgs({ action: "start" })).toMatchObject({ error: /projectId/ })
    expect(parseProjectArgs({ action: "start", projectId: "p" })).toEqual({
      action: "start",
      projectId: "p",
    })
    expect(parseProjectArgs({ action: "pause" })).toMatchObject({ error: /experimentId/ })
    expect(parseProjectArgs({ action: "extend-budget", experimentId: "e" })).toMatchObject({
      error: /budgetCap/,
    })
    expect(parseProjectArgs({ action: "extend-budget", experimentId: "e", budgetCap: 25 })).toEqual(
      { action: "extend-budget", experimentId: "e", budgetCap: 25 }
    )
  })
})
